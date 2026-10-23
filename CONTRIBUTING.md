# Contributing

Thanks for helping improve `dsh-approval-notify-macos`.

## Pull requests

- Prefer **pull requests** into `main` over pushing commits straight to `main`.
- Keep changes focused; do not modify `tests/accept/` unless you are intentionally changing acceptance criteria (those files are owned by the acceptance suite author).
- Run tests locally before opening a PR:

  ```sh
  npm test
  # or: node --test "tests/accept/*.test.mjs"
  ```

## Branch protection (maintainers)

On GitHub, enable **branch protection** for `main`:

1. Require a pull request before merging.
2. Require the status check named **`test`** (from `.github/workflows/test.yml`) to pass before merge.
3. Do not allow direct pushes to `main` when protection is available on your plan.

These settings cannot be enabled from the repository contents alone; they must be configured in the GitHub UI (Settings → Branches).
