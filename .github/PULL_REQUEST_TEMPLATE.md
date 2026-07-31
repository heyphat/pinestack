<!-- Thanks for contributing to pinestack! -->

## What & why

<!-- What does this change, and why? Which package(s) does it touch —
     @heyphat/pinery (data), @heyphat/pinerun (orchestration), or
     @heyphat/pinetop (the TUI)?
     Engine/language changes belong in piner, not here. -->

## Checklist

- [ ] Tests added/updated (bug fixes include a regression test)
- [ ] Determinism preserved — same inputs still produce the same `jobHash`/result
- [ ] `bun test` passes
- [ ] `bun run typecheck` passes
- [ ] `bun run format` applied
- [ ] API credentials are read from env vars only — none hardcoded or logged
- [ ] Commit messages follow Conventional Commits

<!-- If you added, renamed, or removed a pinerun flag, or changed a --json shape: -->

- [ ] `bun packages/pinetop/src/cli.ts --check-flags` still agrees (the TUI models
      pinerun's flags by hand, and parses its `--json` payloads)
