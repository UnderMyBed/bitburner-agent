# S1: headless engine (throwaway)

Runs the real game engine from `vendor/bitburner-src` in plain Node under a fake clock and seeded RNG. Findings: [`docs/spikes/s1-headless-engine.md`](../../docs/spikes/s1-headless-engine.md).

```sh
# once: the game's own dependencies, then the spike's
cd vendor/bitburner-src && ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci && cd -
cd spikes/s1-headless-engine && npm ci
node build.mjs                                     # bundle the engine -> dist/engine.cjs

node run.mjs --hours 6 --seed 1                    # one looping hack script
node run.mjs --scenario batch --hours 6            # controller exec()ing worker scripts
node run.mjs --scenario batch --ram 65536 --max-threads 1 --per-tick 25 --no-log   # ~3k processes
node run.mjs --hours 1 --save-out prof/s.json.gz   # write the game's own save
node run.mjs --load <save.json.gz> --start <epoch ms> --hours 2   # boot from a save (e.g. a Steam save copy)
node --cpu-prof --cpu-prof-dir=prof run.mjs ... && node prof-top.mjs   # profile
```

Each run prints a JSON summary with `speedup` and a `stateHash`. Same seed and same inputs give the same hash.

| File | Role |
|---|---|
| `build.mjs` | esbuild bundle of the engine, mirroring the game's `jest.config.js` module mapping |
| `engine-entry.ts` | The only code bundled with the engine: boot, run scripts, read state |
| `run.mjs` | jsdom globals, fake timers, seeded RNG, `blob:` module hook, scenarios, reporting |
| `stubs/` | Stand-ins for UI-only packages (Monaco, swc) |

Copies of real saves go in `fixtures-local/`, which is gitignored. Never commit them.
