# Contributing to pinestack

Thanks for your interest in contributing! pinestack is the data and
orchestration layer around the [piner](https://github.com/heyphat/piner) Pine
Script v6 engine, and we welcome bug reports, fixes, new data adapters, and
docs.

## Scope

pinestack is two workspace packages:

- **`@heyphat/pinery`** — the data layer: OHLCV history providers that implement
  piner's `DataFeed` contract, timeframe helpers, and a Node on-disk cache.
- **`@heyphat/pinerun`** — the orchestration layer: the job model, determinism
  cache, runners, `scan`/`sweep`/`backtest`/`walkforward`/`portfolio`, and the
  `pinerun` CLI.

Language-engine changes (Pine parsing, codegen, strategy semantics) belong in
[piner](https://github.com/heyphat/piner), not here. `piner` is a **peer
dependency** — pinestack orchestrates it, it does not reimplement it.

## Development setup

Requires [Bun](https://bun.sh) ≥ 1.2.

```bash
git clone https://github.com/heyphat/pinestack.git
cd pinestack
bun install        # links the two workspaces + the piner peer
```

During development each package's `exports` map points at TypeScript source, so
tests and the CLI run with no build step:

```bash
bun test           # full suite across both packages
bun run typecheck  # tsc -b across both packages
bun run format     # prettier --write .
```

Run the CLI straight from source:

```bash
bun packages/pinerun/src/cli.ts scan examples/rsi.pine \
  --symbols BTCUSDT,ETHUSDT,SOLUSDT --tf 1h --limit 300 --rank "last(rsi)" --top 3
```

## Determinism is the contract

A piner run is a pure function of `(source, bars, inputs, backend)`. pinestack
leans on that: runs are keyed by `jobHash`, cached, and fanned out in parallel.
Any change must preserve this — a job with the same inputs must produce the same
result and the same hash. If you touch the job model, the hash, or a runner,
keep the determinism tests green and add one for the new behaviour.

## Data adapters

New history providers implement the `HistoryProvider` contract in
`packages/pinery/src/provider.ts` and are wired through `symbols.ts`. Keep
network access behind the shared retrying `fetchJson` (`http.ts`), read API
credentials from environment variables (never hardcode or log them), and add a
fixture-driven test under `packages/pinery/test/`.

## Workflow

1. Fork and branch off `main` (`fix/...`, `feat/...`).
2. Add or update tests for any behaviour change. Bug fixes need a regression
   test.
3. Make sure `bun test` and `bun run typecheck` both pass, and run
   `bun run format`.
4. Use [Conventional Commits](https://www.conventionalcommits.org/) for messages
   (`feat(pinerun): ...`, `fix(pinery): ...`, `docs: ...`) — the changelog
   depends on it.
5. Open a PR describing **what** changed and **why**.

## Reporting bugs

Open an issue with the exact `pinerun` command (or a minimal script snippet),
the symbols/timeframe involved, what you expected, and what pinestack produced.
A copy-pasteable repro makes fixes far faster.

## License

By contributing, you agree that your contributions are licensed under the
[GNU AGPL-3.0](./LICENSE).
