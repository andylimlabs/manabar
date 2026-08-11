# Contributing

Thanks for the interest. A few things to know before you start:

- **Open an issue or a Discussion before writing code** for anything
  bigger than a small fix. Pull requests for undiscussed features may be
  declined, and I would rather save you the time.
- **Feature ideas go to
  [Discussions → Ideas](https://github.com/andylimlabs/manabar/discussions/categories/ideas)**,
  where upvotes drive the roadmap. Bugs go to issues.
- This project is maintained in spare time. Expect responses in days,
  not hours.

## Non-goals

These are settled; please don't open requests for them:

- No telemetry, analytics, or accounts in the app, ever
- No cloud sync of anything, least of all credentials
- No multi-provider dashboard: the HUD renders one provider at a time
- No polling faster than 60 seconds (the usage endpoints rate-limit)

## Dev setup

Standard [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/)
(Node, Rust), then:

```bash
npm install
npm run tauri dev      # vite on port 1440
```

Before a PR: `npx tsc --noEmit` and `cargo clippy` (from `src-tauri/`)
both clean. No new dependencies without discussion; the small dependency
surface is a deliberate security property.

Engineering conventions (vocabulary rules, the lexicon pivot, the meter
registry, provider facts) live in [.claude/CLAUDE.md](.claude/CLAUDE.md)
and [docs/RELEASE.md](docs/RELEASE.md).
