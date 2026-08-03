/**
 * A pty, with no native module.
 *
 * The editor hand-off used to say this was impossible: a pty means `node-pty`,
 * a native module ends the self-contained single-binary build, so the frame had
 * to go away for the duration. That was true of `openpty` through a compiled
 * addon; it is not true of the libc the OS already ships. `bun:ffi` can dlopen
 * libSystem/libc and call the POSIX pty entry points directly, and a
 * `bun build --compile` binary keeps working — dlopen against a system library
 * is dynamic linking, not a bundled `.node`.
 *
 * Two ABI facts shape everything here, and both were found the hard way:
 *
 *  - **`ioctl` is unusable through FFI on Apple arm64.** It is declared variadic,
 *    and Apple's arm64 ABI passes variadic arguments on the stack while a
 *    fixed-signature FFI call puts them in registers. A `TIOCSWINSZ` issued that
 *    way reads stack garbage: the child saw 45958x1786. So the window size is
 *    set by shelling out to `stty`, which does the ioctl from C where the ABI is
 *    honest. It is a subprocess per resize, and resizes happen at human speed.
 *
 *  - **The master fd must be non-blocking from birth**, because `fcntl` is
 *    variadic too and therefore equally unusable. `posix_openpt` takes its flags
 *    as a plain `int`, so `O_NONBLOCK` goes in at creation and `read` returns
 *    EAGAIN instead of parking the UI thread. This is why the pty is opened the
 *    long way (`posix_openpt` + `grantpt` + `unlockpt` + `ptsname`) rather than
 *    through the one-call `openpty`, whose master comes back blocking.
 *
 * The FFI handle is opened on first use, so a session that never runs a terminal
 * pane never dlopens anything, and the tests do not need a libc to import this.
 */

import { CString, FFIType, dlopen, type Pointer } from 'bun:ffi';
import { closeSync, openSync, readSync, writeSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

export interface PtySize {
  rows: number;
  cols: number;
}

/** `O_RDWR`, and the platform's `O_NONBLOCK` — these differ and matter. */
const O_RDWR = 2;
const O_NONBLOCK = process.platform === 'darwin' ? 0x0004 : 0x800;

/**
 * `TCOFLUSH` for `tcflush`, which is *not* portable as a number: the BSD and Linux
 * headers number the three queue selectors differently, and using the wrong one
 * would silently flush the wrong direction.
 *
 * On a pty master, writes travel toward the slave, so the "output" queue is the one
 * holding bytes the child has not read yet.
 */
const TCOFLUSH = process.platform === 'darwin' ? 2 : 1;

/**
 * Where the POSIX pty calls live. macOS re-exports all of libc from libSystem;
 * on Linux they are in libc proper. Tried in order, first one that opens wins.
 */
const LIBC_CANDIDATES =
  process.platform === 'darwin'
    ? ['/usr/lib/libSystem.B.dylib', 'libSystem.dylib']
    : ['libc.so.6', 'libc.so', 'libc.musl-x86_64.so.1'];

interface LibcPty {
  posix_openpt: (flags: number) => number;
  grantpt: (fd: number) => number;
  unlockpt: (fd: number) => number;
  ptsname: (fd: number) => Pointer | null;
  /** The pty's foreground process group — whatever the user actually ran. */
  tcgetpgrp: (fd: number) => number;
  /** Our own process group, so a kill can never be aimed at pinetop itself. */
  getpgrp: () => number;
  /** Discard queued tty data — used to drop replies the asker never read. */
  tcflush: (fd: number, queue: number) => number;
}

let libc: LibcPty | null = null;
let libcError: string | null = null;

function loadLibc(): LibcPty {
  if (libc != null) return libc;
  if (libcError != null) throw new Error(libcError);

  const failures: string[] = [];
  for (const path of LIBC_CANDIDATES) {
    try {
      const handle = dlopen(path, {
        posix_openpt: { args: [FFIType.i32], returns: FFIType.i32 },
        grantpt: { args: [FFIType.i32], returns: FFIType.i32 },
        unlockpt: { args: [FFIType.i32], returns: FFIType.i32 },
        ptsname: { args: [FFIType.i32], returns: FFIType.ptr },
        tcgetpgrp: { args: [FFIType.i32], returns: FFIType.i32 },
        getpgrp: { args: [], returns: FFIType.i32 },
        tcflush: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      });
      libc = handle.symbols as unknown as LibcPty;
      return libc;
    } catch (err) {
      failures.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  libcError = `no usable libc for pty (${failures.join('; ')})`;
  throw new Error(libcError);
}

/** Test seam: pretend libc is missing, to exercise the no-pty path. */
export function setLibcUnavailable(reason = 'pty unavailable'): void {
  libc = null;
  libcError = reason;
}

export interface PtyOptions {
  argv: readonly string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  size: PtySize;
}

export interface Pty {
  /** Bytes the child has written since the last call; `''` when nothing waits. */
  read(): string;
  /** Send bytes to the child's stdin. */
  write(data: string): void;
  resize(size: PtySize): void;
  /** Discard bytes written toward the child that it has not read yet. */
  flushPendingWrites(): void;
  /**
   * The pty's foreground process group, or -1 when it cannot be read.
   *
   * Identifies *which* program currently owns the terminal, which is what makes a
   * query reply addressable — see `TermSession`'s use of it.
   */
  foregroundGroup(): number;
  /** The child's exit code once it has gone, else null. */
  exitCode(): number | null;
  kill(signal?: NodeJS.Signals): void;
  /** Close the master fd. Safe to call twice. */
  dispose(): void;
}

/**
 * Start a program on a fresh pty.
 *
 * `TERM` is forced to `xterm-256color` because that is the emulator the pane
 * actually implements — inheriting the outer terminal's `TERM` would promise
 * capabilities (sixel, kitty keyboard) that the pane cannot honour, and a child
 * that believes a lie about its terminal renders garbage rather than degrading.
 *
 * `COLUMNS`/`LINES` are deliberately dropped. They are the outer terminal's
 * size, and a child that trusts them over its own `TIOCGWINSZ` would lay itself
 * out for the wrong pane.
 */
export function spawnPty(opts: PtyOptions): Pty {
  const lib = loadLibc();

  const master = lib.posix_openpt(O_RDWR | O_NONBLOCK);
  if (master < 0) throw new Error('posix_openpt failed');
  if (lib.grantpt(master) !== 0) {
    closeSync(master);
    throw new Error('grantpt failed');
  }
  if (lib.unlockpt(master) !== 0) {
    closeSync(master);
    throw new Error('unlockpt failed');
  }
  const namePtr = lib.ptsname(master);
  if (namePtr == null) {
    closeSync(master);
    throw new Error('ptsname failed');
  }
  const slavePath = new CString(namePtr).toString();

  // The slave has to be open before the size is set: `stty` on an unopened pty
  // reports success and changes nothing, and the child then wakes up at 0x0.
  const slave = openSync(slavePath, 'r+');
  applySize(slavePath, opts.size);

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(opts.env ?? process.env)) {
    if (value != null) env[key] = value;
  }
  delete env['COLUMNS'];
  delete env['LINES'];
  env['TERM'] = 'xterm-256color';

  const child = Bun.spawn([...opts.argv], {
    cwd: opts.cwd,
    env,
    stdio: [slave, slave, slave],
  });

  // The parent's copy of the slave goes now. Holding it would keep the pty open
  // after the child died, so the master would never see EOF and a dead shell
  // would look like an idle one.
  closeSync(slave);

  const buffer = Buffer.alloc(65536);
  let masterOpen = true;
  let size = opts.size;

  // A pty read stops at whatever byte the buffer ends on, which can be the middle
  // of a multi-byte character — and `Buffer.toString('utf8')` on a split sequence
  // yields U+FFFD, permanently corrupting the cell. Box drawing, CJK and emoji all
  // hit this, and it appears at random depending on where the chunk boundary lands.
  // The decoder holds the incomplete tail until the rest of it arrives.
  const decoder = new StringDecoder('utf8');

  return {
    read(): string {
      if (!masterOpen) return '';
      let out = '';
      // Drain what is queued rather than one chunk per frame, or a burst of
      // output (a `ls` of something large) would arrive over many frames and the
      // pane would visibly crawl.
      for (;;) {
        let n: number;
        try {
          n = readSync(master, buffer, 0, buffer.length, null);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          // EAGAIN: nothing waiting, which is the normal case.
          // EIO: the child hung up — the pty's last slave closed.
          if (code === 'EAGAIN') break;
          if (code === 'EIO') break;
          break;
        }
        if (n <= 0) break;
        out += decoder.write(buffer.subarray(0, n));
        if (n < buffer.length) break;
      }
      return out;
    },

    write(data: string): void {
      if (!masterOpen || data === '') return;
      try {
        writeSync(master, data);
      } catch {
        // A write to a pty whose child has gone is not an error worth surfacing:
        // the exit is the event the caller reacts to, and it is already visible
        // through exitCode().
      }
    },

    resize(next: PtySize): void {
      if (!masterOpen) return;
      if (next.rows === size.rows && next.cols === size.cols) return;
      size = next;
      applySize(slavePath, next);
    },

    /**
     * Throw away anything written toward the child that it has not read.
     *
     * Used at the moment one program in the pane replaces another. Query replies
     * are addressed to whoever asked, and the asker can exit with an answer still
     * queued — at which point the shell that takes its place reads the answer as if
     * it had been typed. Discarding the queue at the handover is what stops a
     * cursor report turning into `command not found: 35`.
     */
    flushPendingWrites(): void {
      if (!masterOpen) return;
      safe(() => lib.tcflush(master, TCOFLUSH), -1);
    },

    foregroundGroup(): number {
      if (!masterOpen) return -1;
      return safe(() => lib.tcgetpgrp(master), -1);
    },

    exitCode(): number | null {
      return child.exitCode;
    },

    /**
     * Kill the child *and* whatever it was running.
     *
     * Signalling `child.pid` alone is not enough and the reason is job control: an
     * interactive shell puts every job it starts into its **own** process group, so
     * a `SIGHUP` aimed at the shell never reaches the program running in it. Close
     * a pane with `claude` or `vim` open and the shell dies while the program keeps
     * running, detached, reading from a pty whose master has gone.
     *
     * A real terminal does not have this problem: its child is a session leader
     * with the pty as its controlling terminal, so closing the master makes the
     * *kernel* hang up the foreground process group. `Bun.spawn` cannot `setsid`,
     * so that path is unavailable and the hangup is delivered by hand — ask the
     * pty who is in the foreground (`tcgetpgrp`) and signal that group.
     *
     * Then escalate. `SIGHUP` is the polite request that lets a shell write its
     * history file; anything still alive a moment later is not going to leave on
     * its own, and a pane that is already gone from the screen must not leave a
     * process behind it.
     */
    kill(signal: NodeJS.Signals = 'SIGHUP'): void {
      const groups: number[] = [];
      const own = safe(() => lib.getpgrp(), -1);

      if (masterOpen) {
        const foreground = safe(() => lib.tcgetpgrp(master), -1);
        // Never our own group: a failed spawn or a closed pty can report it, and
        // `kill(-ourGroup)` would take pinetop down with it.
        if (foreground > 0 && foreground !== own) groups.push(foreground);
      }
      // The shell's own group too, for the case where nothing is in the foreground.
      if (child.pid > 0 && child.pid !== own && !groups.includes(child.pid)) {
        groups.push(child.pid);
      }

      for (const group of groups) safe(() => process.kill(-group, signal), undefined);
      safe(() => child.kill(signal), undefined);

      // Unref'd so it can never hold the process open on its own account. If the
      // app exits first the groups have already had their SIGHUP, and the OS
      // reparents whatever is left.
      const escalation = setTimeout(() => {
        for (const group of groups) safe(() => process.kill(-group, 'SIGKILL'), undefined);
        safe(() => child.kill('SIGKILL'), undefined);
      }, 250);
      escalation.unref?.();
    },

    dispose(): void {
      if (!masterOpen) return;
      masterOpen = false;
      try {
        closeSync(master);
      } catch {
        // Already closed.
      }
    },
  };
}

/**
 * Run a syscall that is allowed to fail. Teardown runs against processes that may
 * already be gone and fds that may already be closed, and an ESRCH there is the
 * expected outcome rather than something to report.
 */
function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/**
 * Set a pty's window size via `stty`, which is the only route left once `ioctl`
 * is off the table (see the header). Failure is silent on purpose: a child laid
 * out at the wrong size is a cosmetic problem, and there is nothing useful the
 * pane could say about it that would not be noise on every resize.
 */
function applySize(slavePath: string, size: PtySize): void {
  const flag = process.platform === 'darwin' ? '-f' : '-F';
  const rows = String(Math.max(1, Math.floor(size.rows)));
  const cols = String(Math.max(1, Math.floor(size.cols)));
  try {
    Bun.spawnSync(['stty', flag, slavePath, 'rows', rows, 'cols', cols], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
  } catch {
    // No stty on PATH. The child keeps whatever the kernel gave it.
  }
}
