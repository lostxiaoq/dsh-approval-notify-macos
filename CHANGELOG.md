# Changelog

## 0.1.3 — 2026-10-23

Security and engineering hardening:

- **PATH / env binary hardening**: stop scanning `process.env.PATH` for `terminal-notifier`; only Homebrew absolute candidates. `DSH_APPROVAL_NOTIFY_TN` / `DSH_APPROVAL_NOTIFY_OSASCRIPT` overrides are honored only when the path is absolute and under `os.tmpdir()` (accept-test hooks); otherwise ignored.
- **Log path hardening**: append to `DSH_APPROVAL_NOTIFY_LOG` only when the path is absolute and under `os.tmpdir()`; otherwise skip the write silently.
- **Privacy**: new config `includeReason` (default `true`). When `false`, notification body is tool name only.
- **CI**: `npm test` script and GitHub Actions workflow on `ubuntu-latest` for push/PR to `main`.
- **Process docs**: `SECURITY.md`, `CONTRIBUTING.md` (branch protection + required `test` check still configured manually in GitHub UI).
- **Sound whitelist**: only known macOS system sounds; unknown → `Glass`. Control characters stripped from sound before AppleScript.
- **Debug observability**: non-empty `DSH_APPROVAL_NOTIFY_DEBUG` logs one-line `console.error` on TN/osascript failure or unsafe log skip (still never throws).
- **Cleanup**: drop unused `homedir` import; use `tmpdir` for path checks.
- **displayReason**: always prefer `zh` then `en` (matches SPEC + accept test; stable on non-zh CI locales).
