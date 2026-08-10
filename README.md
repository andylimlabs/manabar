# manabar

An MMO-style mana bar for your Claude token limits. A click-through overlay pinned to the bottom edge of every display, showing your subscription meters the way a game would: mana that drains as you play and refills on a timer.

## What it shows

- **Session (mana)**: the teal bar. Your 5-hour window, the fast loop. Drains as you burn tokens, refills fully at reset with a gold sweep and a "+N% mana refilled" note.
- **Week**: the indigo strip with 14 segments (one per half-day). The slow, consequential budget.
- **Fable**: the orange fill sharing the weekly strip. The per-model weekly cap. Whichever weekly is lower renders in front.
- **Ghosts**: when mana drops between polls, a pale segment lingers where it was and fades out. A fat ghost trail means something is eating tokens right now.
- **The pill**: `74% mana left · refills in 3h 53m │ ▮ fable 69% │ ▮ week 83%`

## How it works

The primary window polls Anthropic's OAuth usage endpoint once a minute (token read from the Claude Code entry in the macOS Keychain, never stored). Results are cached in the Rust core and broadcast to the bars on other displays, so extra displays never mean extra API traffic. Non-200 responses keep the last good data on screen and back off exponentially.

A reconciler keeps one bar per display: plug in a monitor and a bar appears, unplug it and the bar is cleaned up.

## Tray menu

- **Hide bars / Show bars**: toggles every bar.
- **All displays**: bar on every screen vs primary only (persisted).
- **Quit manabar**.

## Dev

```bash
npm install
npm run tauri dev   # vite on port 1440
```

Bars are fully click-through; drive verification via the stubbed-`__TAURI_INTERNALS__` harness pattern (see memory/state notes) rather than clicking.

## Stack

Tauri 2, vanilla TypeScript, no runtime dependencies beyond the Tauri API. macOS first.
