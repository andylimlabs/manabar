# manabar

MMO-style mana bar overlay for Claude token limits. Owned by staff-engineer-mira.

## Vocabulary (Andy's, use exactly)

- **Mana = session-based limits ONLY.** Pill says "74% mana left", "mana tapped", "refills in". A provider with no session window (codex Plus) has NO mana bar: its weekly renders in the weekly strip (indigo, ticks), pill "week 88% · resets in 5d 9h". Never borrow the mana slot for a weekly pool.
- Fable = the per-model weekly cap (orange #d97757). Week = all-models weekly (indigo #6e7bf2). Mana bar is teal #5ecbba. Pill order: mana, then scoped (fable), then week.
- Bubbles/segments (14 = 7 days x 2) are AESTHETIC ONLY. Fills move by continuous usage percent, never snap to ticks.
- **One provider per HUD** (tray Provider submenu, Claude is the default). Never a multi-sub dashboard.
- **Expandable, not dynamic**: strip meters come from the curated registry in each provider mapper (mapClaude/mapCodex). New API dimensions get console.warn'd, never auto-rendered; adding one is a deliberate registry entry with a chosen label and color.

## Hard-won facts

- Usage data: `https://api.anthropic.com/api/oauth/usage`, Bearer token from Keychain entry "Claude Code-credentials" (`.claudeAiOauth.accessToken`), header `anthropic-beta: oauth-2025-04-20`. The `limits[]` array is the source of truth (session / weekly_all / weekly_scoped with `is_active` marking the binding limit). Top-level five_hour/seven_day fields are incomplete.
- **The endpoint rate-limits hard.** Never poll faster than 60s, never let more than one window poll (primary polls, broadcasts; secondaries read the Rust LAST_USAGE cache). Do not curl it manually while the app runs.
- Multi-window sync: never rely on emit alone; late-joining windows pull `cached_usage` on boot.
- Windows are click-through (`set_ignore_cursor_events`), frameless, transparent, accessory policy. `macOSPrivateApi: true` in config requires the `macos-private-api` cargo feature or the build fails.
- Position math in LOGICAL coordinates only (mixed-DPI displays).

## Dev

- `npm run tauri dev`, vite port **1440** (registry: 1420 companion, 1430 suji, 1435 toka). Launch detached: `nohup npm run tauri dev > ~/Library/Logs/manabar-dev.log 2>&1 & disown`.
- Verify UI via a temp `harness-app.html` at repo root stubbing `window.__TAURI_INTERNALS__` (invoke returns canned usage JSON; `?poll=` speeds the poll for ghost/refill testing). Delete the harness after. The real bars cannot be clicked.
- Logo source: `design/logo.svg` (mana flask). Regenerate icons: `npm run tauri icon design/logo.svg`.

## Design direction

Playful vocabulary, professional execution. Research-grounded HUD grammar lives in `design/ui-proposals.html`. Parked ideas: pace notch, at-pace projection, P4 detail view toggle, per-message ghosts via local JSONL transcripts, absolute-clock refill display.
