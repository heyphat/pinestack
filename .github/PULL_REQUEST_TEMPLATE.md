<!-- Thanks for contributing to pinestack! -->

## What & why

<!-- What does this change, and why? Which package(s) does it touch —
     @heyphat/pinery (data) or @heyphat/pinerun (orchestration)?
     Engine/language changes belong in piner, not here. -->

## Checklist

- [ ] Tests added/updated (bug fixes include a regression test)
- [ ] Determinism preserved — same inputs still produce the same `jobHash`/result
- [ ] `bun test` passes
- [ ] `bun run typecheck` passes
- [ ] `bun run format` applied
- [ ] API credentials are read from env vars only — none hardcoded or logged
- [ ] Commit messages follow Conventional Commits
