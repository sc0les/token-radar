# Token Radar

Experimental Node CLI that discovers token contracts through public
GeckoTerminal and DexScreener endpoints, merges candidates, applies liquidity
and age filters, and emits ranked JSONL. No API keys or trading integration.

## Run

Node 18+ is declared by the original package; local checks used Node 26.8.1.
There are no npm dependencies.

```sh
node bin/radar.js --help
node bin/radar.js once --chains base,solana --top 15
node bin/radar.js once --chains base --min-liq 1000 --stdout-only
node --test
```

Default output is a timestamped file under `out/` as well as stdout. Use
`--out PATH` to choose a file or `--no-out` / `--stdout-only` to suppress files.
`--require-metrics` excludes candidates missing required filter inputs.

The ranking combines source agreement, liquidity, volume, and attention signals.
It is a research heuristic, not a forecast, recommendation, or safety rating.

## Scheduling

`bin/radar-once.sh` is a one-shot wrapper. The example under `launchd/` is not
installed or enabled. Replace every `/path/to` placeholder and ensure Node is
on the launch agent's PATH before choosing a schedule. Running the CLI manually
does not install a background service.

## Known limitations

- Upstream responses and chain mappings can change or be unavailable.
- Results can be incomplete even when the process exits successfully.
- The current deduplication lowercases addresses, including Solana addresses;
  Solana identifiers are case-sensitive. Treat deduplication as experimental.
- Backoff reduces request pressure but cannot ensure provider availability.
- Saved candidates, wallet research, logs, and previous real output are omitted.

Offline checks cover CLI help, argument parsing, numeric handling, and bounded
retry delays. No public-provider smoke test was run during this export.

## History

August-October 2026 commits are retrospective imports of existing local code.
Their assigned dates organize the import; they are not original development
timestamps. Export documentation and additional checks are dated when added.
