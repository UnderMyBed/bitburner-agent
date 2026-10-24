# Mechanics references

First-principles references for every game subsystem. They were extracted from the game source at **v3.0.1** (`vendor/bitburner-src` @ `1da7316ff`), not from wikis or memory.

- `file:line` citations are relative to `vendor/bitburner-src/` (usually `src/…`) unless a doc says otherwise. Paths starting with `scripts/` refer to the legacy [bitburner-scripts](https://github.com/UnderMyBed/bitburner-scripts) fork.
- Notes marked **3.0.2** come from the upstream `dev` branch as of 2026-10 and describe changes that aren't released yet.
- Everything was read from source; none of it has been verified in a running game unless a doc says so. When the agent's behaviour depends on a claim here, there should be a formula-parity test or a simulator test backing it.

| Doc | Covers |
|---|---|
| [progression.md](progression.md) | BitNodes, Source-Files, win conditions, prestige, what persists, pre-SF4 UI-only actions |
| [hacking-economy.md](hacking-economy.md) | Hack/grow/weaken, servers, script RAM model, hacknet, stocks, timing |
| [factions-augs-work.md](factions-augs-work.md) | Factions, augmentations, reputation and favor, companies, crime, grafting |
| [gang-bladeburner-sleeves-stanek.md](gang-bladeburner-sleeves-stanek.md) | Gangs, Bladeburner, sleeves, Stanek's Gift |
| [corporation.md](corporation.md) | Corporations end to end |
| [darknet-bn15.md](darknet-bn15.md) | BN15 Dark Net: puzzles, solvers, `ns.dnet` |
| [minigames-exploits.md](minigames-exploits.md) | IPvGO, infiltration, casino, coding contracts, exploits |
