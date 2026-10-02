# Notes for Claude

- Before adding or fixing a site adapter, read `docs/hard-sites-playbook.md`.
  It covers sites that need the user's own account access (like Kakao Page) and
  sites that Cloudflare blocks from the build environment (like Lua Comic): how
  to classify them, what to ask the user to capture, and the files to change.
- Never download paid, early-access or ad-locked chapters: mark them
  `isFree: false` and refuse them before any request. Never bypass a paywall,
  DRM, or anti-bot block.
- Reply to the owner (Max) in Thai.
- Checks: `npm test` (unit) and `npm run test:browser` (loads the extension in Chromium).
