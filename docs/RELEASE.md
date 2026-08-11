# Release checklist

> TODO (parked, revisit): GitHub Actions release pipeline — tag-triggered
> tauri-action build on a macOS runner, Developer ID cert + notary
> credentials as repo secrets, notarize + staple in CI, publish the
> Release with a stable `manabar.dmg` asset name so the site's
> `/releases/latest/download/manabar.dmg` URL never changes. Until then,
> releases follow the manual checklist below.

> DECIDED 2026-08-10: no auto-updater in v0.1, deliberately. The Tauri
> updater keypair does not exist yet, so early installs update by
> downloading a new DMG. Revisit once there is a real install base;
> adding the updater at that point strands only pre-updater installs
> on manual downloads, which is the accepted trade.

Run every item before publishing a build. No skips.

## Audits

- [ ] `npm audit --omit=dev` reports 0 vulnerabilities
- [ ] `cargo audit` (from `src-tauri/`) reports no advisories, or each advisory is reviewed and noted here
- [ ] `npx tsc --noEmit` clean
- [ ] `cargo clippy --all-targets` clean

## Build

- [ ] `npm run tauri build -- --target universal-apple-darwin` succeeds (universal: Apple Silicon + Intel in one binary; needs `rustup target add x86_64-apple-darwin` once)
- [ ] `lipo -archs` on the bundled binary shows `x86_64 arm64`
- [ ] Launch the bundled .app (not the dev build) and verify: bars render, pill shows live data, tray menu works, Preview animations runs
- [ ] Verify the production CSP did not break the webview (bars blank = CSP problem; check the webview console)

## Signing

- [ ] Developer ID signing configured, hardened runtime enabled
- [ ] `spctl -a -vv` accepts the app
- [ ] Notarization submitted and stapled (`xcrun notarytool`, `xcrun stapler`)

## Distribution

- [ ] DMG uploaded to the public releases repo
- [ ] Release notes written (plain language, no internal codenames)
- [ ] Site download link points at the new release
- [ ] README install instructions still accurate

## Privacy facts (keep true, disclose if they change)

- Credentials are read from the user's own keychain / `~/.codex/auth.json` and sent only to the provider's own API over TLS. Never stored, never sent anywhere else.
- The disk cache (`last_usage.json`) contains meter percentages and reset times only. The Rust boundary strips everything else (including Codex account fields) before data reaches the cache or webviews.
