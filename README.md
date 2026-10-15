# haxballgh5

Backend of HaxBall Desktop ([GonzaloH5/haxballapp](https://github.com/GonzaloH5/haxballapp)): accounts
signed in with Discord, one session per app profile, and a unique nick. Cloudflare Worker + D1.

- `POST /auth/start` → `{ state, url }`; the app opens `url` (Discord) in the browser.
- `GET /auth/callback` → Discord comes back here; the Worker makes the session.
- `GET /auth/poll?state=` → `202` while waiting, `200 { token, user, needsNick }` once, `410` if it expired or failed.
- With `Authorization: Bearer <token>`: `GET /me`, `POST /me/nick { nick }`, `POST /auth/logout`.

Only the SHA-256 of session tokens is stored. Sessions last 90 days from their last use.

## Setup

- Discord app "HaxBall": OAuth2 redirect `https://haxballgh5.gonzalo20062010.workers.dev/auth/callback`.
- Secret: `npx wrangler secret put DISCORD_CLIENT_SECRET` (never in the repo; locally in `.dev.vars`).
- Database: `npx wrangler d1 migrations apply haxballgh5 --remote` after adding a file to `migrations/`.
- Every push to `main` deploys (Cloudflare Workers Builds, `npx wrangler deploy`).

Local: `npm install`, `npx wrangler d1 migrations apply haxballgh5 --local`, `npm run dev`; tests: `npm test`.
