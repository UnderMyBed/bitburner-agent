# Spikes

Time-boxed experiments that answer one question. The code here is **throwaway**: no tests, no merge-gate standards, not imported by anything. Each spike's findings live in [`docs/spikes/`](../docs/spikes/), and anything worth keeping is rebuilt test-first in `packages/`.

| Spike | Question | Result |
|---|---|---|
| [`s1-headless-engine/`](s1-headless-engine/) | Can the real engine run headless in Node, deterministically and fast? | Pass: [report](../docs/spikes/s1-headless-engine.md) |
