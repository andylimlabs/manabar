# Security Policy

## Reporting

Report vulnerabilities through GitHub private vulnerability reporting:
https://github.com/andylimlabs/manabar/security/advisories/new

Do not open public issues for security problems, and never include real
tokens or credential file contents in any report.

## Response targets

Acknowledgement within 72 hours; assessment within 7 days; fix or
mitigation plan within 30 days for confirmed issues. This is a
solo-maintained project, so targets are best effort.

## Scope and threat model

manabar reads credentials from local CLI sign-ins (read-only): the
Claude Code keychain entry and `~/.codex/auth.json`.

In scope, highest priority:

- Any path by which credential material could leave the machine beyond
  the provider's own API call (network calls, logs, caches, crash
  reports)
- Credential material written to disk anywhere, or with weakened
  permissions
- Tauri IPC or capability escapes exposing credential data to a webview
  or injected content
- Anything that makes the rendered pill execute attacker-controlled
  markup

In scope, normal: standard code execution, injection, and dependency
vulnerabilities.

Out of scope: attacks requiring an already-compromised local account (a
local attacker with your user privileges can read the same credential
files directly), and issues only reproducible in dev builds.

## Supported versions

Only the latest release receives security fixes.

## Guarantees we make (verify us)

- manabar never transmits credentials anywhere except the provider's own
  API over TLS, and never stores them.
- The code that touches tokens is deliberately small:
  [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs).
- Payloads are stripped to the fields the HUD renders before anything is
  cached or crosses into a webview.
- There is no telemetry, no account, and no server of ours involved.
