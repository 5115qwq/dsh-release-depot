# Changelog

## 1.1.0

- Rename the product to 发布仓 / Release Depot (package: `dsh-release-depot`); migrate old `.dsh-ship-deck` credentials.
- Automatic npm token expiry detection through `/-/npm/v1/tokens`; expiry warning at 21 days; Bypass-2FA warning.
- Correct npm token page link to `https://www.npmjs.com/settings/~/tokens`.
- npm access-level management and maintainer add/remove (UI + AI tools).
- Fix GitHub pushes into a brand-new empty repository (bootstrap initial commit + default branch).
- Better npm error mapping (already-published, bypass-token limitations, stage-only, WebAuthn/TOTP).
- Hide panel scrollbars; four-sided rounded frame with hard shadow; follow the DSH theme automatically.
- Sidebar entry, `设置 → 发布仓`, and plugin detail "open workbench" entry.
- Product README, plugin details, and publish metadata for npm/GitHub.

## 1.0.0

- Initial release: npm and GitHub accounts, publish wizard (npm / GitHub Packages / GitHub Release), dist-tags, deprecate, unpublish, owner/access, local history, and five AI tools.