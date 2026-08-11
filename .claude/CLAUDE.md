# manabar

MMO-style stamina bar overlay for coding-agent usage limits. Tauri 2, vanilla TypeScript, macOS-first.

## Vocabulary (locked, use exactly)

- The default readout is plain: every meter reads swatch + label + value: "session 74% · refills in 3h 53m". Session limits use "refills in"; weekly limits use "resets in".
- **Gamer mode** brings the mana vocabulary back ("74% mana left"). ALL mode-dependent strings live in the LEXICONS pivot in `src/main.ts` (plain | gamer). Never inline a mode-conditional string anywhere else; new wording means editing both variants of one lexicon entry.
- "mana" appears only in the product name and gamer mode. The session meter is teal, weekly is indigo, the per-model weekly cap is orange. Color encodes timescale; never render a weekly pool in the session slot.
- Segment ticks (14 = 7 days x 2 half-days) are aesthetic only. Fills move by continuous usage percent, never snap to ticks.

## Architecture rules

- **One provider per HUD.** The tray Provider submenu switches between Claude and Codex; never a multi-provider dashboard. Claude is the default.
- **Expandable, not dynamic.** Strip meters come from the curated registry in each provider mapper (`mapClaude`/`mapCodex`). Unknown API dimensions get `console.warn`, never auto-rendered; supporting one is a deliberate registry entry with a chosen label and color.
- **Only the main window polls.** The usage endpoints rate-limit aggressively: never poll faster than 60s, never let more than one window fetch. Secondary bars read the Rust-side cache (`cached_usage`) on a local 5s poll; never trust window-to-window events for data.
- Data minimization at the Rust boundary: `fetch_usage` projects provider payloads down to the fields the HUD renders before anything is cached or crosses to a webview.
- Position math in LOGICAL coordinates only (mixed-DPI displays).

## Provider facts

- Claude: `https://api.anthropic.com/api/oauth/usage`, Bearer token from the macOS Keychain entry `Claude Code-credentials` (`.claudeAiOauth.accessToken`), header `anthropic-beta: oauth-2025-04-20`. The `limits[]` array is the source of truth (session / weekly_all / weekly_scoped; `is_active` marks the binding limit).
- Codex: `https://chatgpt.com/backend-api/wham/usage`, Bearer token + `chatgpt-account-id` from `~/.codex/auth.json`. `rate_limit.primary_window` / `secondary_window` carry `used_percent` and `reset_at` (unix seconds). Plans with only a weekly window render a single bar.
- Tokens are passed to curl via stdin (`-H @-`), never argv. Binaries are invoked by absolute path (`/usr/bin/curl`, `/usr/bin/security`).

## Dev notes

- `npm run tauri dev` (vite port 1440), `npm run tauri build` for release bundles.
- The bars are click-through, so UI verification uses a temporary `harness-app.html` at repo root stubbing `window.__TAURI_INTERNALS__` (invoke returns canned usage JSON; `?poll=` speeds polling for ghost/refill testing; `window.dispatchEvent(new Event("manabar-demo"))` runs the animation preview). Delete the harness when done.
- Icon files are not in cargo's dependency graph: after `npm run tauri icon design/logo.svg`, `touch src-tauri/tauri.conf.json` to force the re-embed.
- `macOSPrivateApi: true` in tauri.conf.json requires the `macos-private-api` cargo feature or the build fails.
- Release checklist: `docs/RELEASE.md`.
