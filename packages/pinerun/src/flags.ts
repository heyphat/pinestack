/**
 * Small pure CLI-flag parsers, extracted from cli.ts so they are unit-testable
 * (cli.ts executes `main()` at import and cannot be imported by tests).
 */

/**
 * Tri-state boolean flag: `--flag` / `--flag=true` → true, `--no-flag` /
 * `--flag=false` → false, absent → undefined (each command decides the
 * default). Throws RangeError on any other value — the caller converts that
 * to its own fail-fast surface.
 */
export function parseTriStateFlag(
  value: string | undefined,
  bareSet: boolean,
  negatedSet: boolean,
  name: string,
): boolean | undefined {
  if (value != null) {
    if (value !== 'true' && value !== 'false')
      throw new RangeError(`invalid --${name}: "${value}" (expected true or false)`);
    return value === 'true';
  }
  if (bareSet) return true;
  if (negatedSet) return false;
  return undefined;
}
