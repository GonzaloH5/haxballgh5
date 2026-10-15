# haxballgh5

Backend of HaxBall Desktop ([GonzaloH5/haxballapp](https://github.com/GonzaloH5/haxballapp)): accounts
signed in with Discord, one session per app profile, and a unique nick. Cloudflare Worker + D1.

- `POST /auth/start` → `{ state, url }`; the app opens `url` (Discord) in the browser.
- `GET /auth/callback` → Discord comes back here; the Worker makes the session.
- `GET /auth/poll?state=` → `202` while waiting, `200 { token, user, needsNick }` once, `410` if it expired or failed.
- With `Authorization: Bearer <token>`: `GET /me`, `POST /me/nick { nick }`, `POST /auth/logout`.
- Friends: `GET /friends` → `{ friends, incoming, outgoing, blocked }`; `POST /friends/request { nick }` (accepts
  theirs if they asked first); `POST /friends/accept|decline|cancel|remove|block|unblock { id }`. Others are
  shown by nick and Discord picture only; whoever blocked you cannot be found.
- Presence: the app sends `POST /presence { room: { name, link, players, max } | null, playing }` every 15 s
  (`{ offline: true }` when it closes); `GET /friends` gives each friend `presence`: online and their room, or
  `lastSeen`. Silent for 45 s means offline.

Only the SHA-256 of session tokens is stored. Sessions last 90 days from their last use.

## Setup

- Discord app "HaxBall": OAuth2 redirect `https://haxballgh5.gonzalo20062010.workers.dev/auth/callback`.
- Secret: `npx wrangler secret put DISCORD_CLIENT_SECRET` (never in the repo; locally in `.dev.vars`).
- Database: `npx wrangler d1 migrations apply haxballgh5 --remote` after adding a file to `migrations/`.
- Every push to `main` deploys (Cloudflare Workers Builds, `npx wrangler deploy`).

Local: `npm install`, `npx wrangler d1 migrations apply haxballgh5 --local`, `npm run dev`; tests: `npm test`.
