// HaxBall Desktop accounts: sign in with Discord, a session per app profile,
// and a unique nick. The desktop app (GonzaloH5/haxballapp) is the only client.
//
// Login, without the app having to receive a redirect itself:
//   1. POST /auth/start          -> { state, url }; the app opens url in the browser
//   2. Discord -> GET /auth/callback?code&state: the Worker trades the code for
//      the Discord user, creates the session and keeps its token under state
//   3. GET /auth/poll?state      -> 202 until then; 200 { token, user, needsNick }
//      once (the token is then forgotten here); 410 when it expired or failed
// Then, with "Authorization: Bearer <token>":
//   GET /me, POST /me/nick { nick }, POST /auth/logout

import { cleanNick, nickKey, nickProblem } from './nick.js';
import { friendsRoute } from './friends.js';

const LOGIN_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const DISCORD = 'https://discord.com';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const fail = (status, error) => json({ error }, status);

function randomToken(bytes = 32) {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...data)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

const redirectUri = env => `${env.PUBLIC_URL.replace(/\/+$/, '')}/auth/callback`;

const publicUser = row => ({
  id: row.id,
  nick: row.nick || null,
  discordName: row.discord_name,
  discordAvatar: row.discord_avatar ? `https://cdn.discordapp.com/avatars/${row.discord_id}/${row.discord_avatar}.png?size=64` : null
});

// ---- Login ------------------------------------------------------------------------

async function authStart(env) {
  const now = Date.now();
  await env.DB.prepare('DELETE FROM logins WHERE created_at < ?').bind(now - LOGIN_TTL_MS).run();
  const state = randomToken(24);
  await env.DB.prepare('INSERT INTO logins (state, created_at) VALUES (?, ?)').bind(state, now).run();
  const url = new URL(`${DISCORD}/oauth2/authorize`);
  url.search = new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, response_type: 'code', redirect_uri: redirectUri(env), scope: 'identify', state, prompt: 'none' });
  return json({ state, url: url.toString(), expiresInMs: LOGIN_TTL_MS });
}

async function discordUser(env, code) {
  const tokenResponse = await fetch(`${DISCORD}/api/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: redirectUri(env) })
  });
  if (!tokenResponse.ok) throw new Error(`Discord rejected the login (${tokenResponse.status})`);
  const { access_token: accessToken } = await tokenResponse.json();
  const userResponse = await fetch(`${DISCORD}/api/users/@me`, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!userResponse.ok) throw new Error(`Discord did not return the user (${userResponse.status})`);
  return userResponse.json();
}

const page = (title, text) => new Response(
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title>` +
  `<body style="font:16px system-ui,sans-serif;background:#1a2125;color:#fff;display:grid;place-items:center;height:100vh;margin:0">` +
  `<div style="text-align:center;max-width:420px;padding:16px"><h1 style="font-size:22px">${title}</h1><p style="opacity:.75">${text}</p></div>`,
  { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }
);

async function authCallback(env, params) {
  const state = params.get('state') || '';
  const login = await env.DB.prepare('SELECT * FROM logins WHERE state = ?').bind(state).first();
  if (!login || Date.now() - login.created_at > LOGIN_TTL_MS || login.token || login.error) {
    return page('Login expired', 'Start the login again from HaxBall Desktop.');
  }
  const code = params.get('code');
  if (!code) {
    await env.DB.prepare('UPDATE logins SET error = ? WHERE state = ?').bind(params.get('error') || 'cancelled', state).run();
    return page('Login cancelled', 'You can close this tab and try again from HaxBall Desktop.');
  }
  try {
    const user = await discordUser(env, code);
    const now = Date.now();
    const name = String(user.global_name || user.username || 'Discord user').slice(0, 64);
    await env.DB.prepare(
      'INSERT INTO users (discord_id, discord_name, discord_avatar, created_at, last_seen) VALUES (?1, ?2, ?3, ?4, ?4) ' +
      'ON CONFLICT(discord_id) DO UPDATE SET discord_name = ?2, discord_avatar = ?3, last_seen = ?4'
    ).bind(String(user.id), name, user.avatar || null, now).run();
    const row = await env.DB.prepare('SELECT id FROM users WHERE discord_id = ?').bind(String(user.id)).first();
    const token = randomToken();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').bind(await sha256(token), row.id, now, now + SESSION_TTL_MS),
      env.DB.prepare('UPDATE logins SET token = ? WHERE state = ?').bind(token, state)
    ]);
    return page('Signed in', `Hi ${name}! You can close this tab and go back to HaxBall Desktop.`);
  } catch (err) {
    await env.DB.prepare('UPDATE logins SET error = ? WHERE state = ?').bind(String(err.message).slice(0, 200), state).run();
    return page('Login failed', 'Discord did not let us in. Close this tab and try again from HaxBall Desktop.');
  }
}

async function authPoll(env, params) {
  const state = params.get('state') || '';
  const login = await env.DB.prepare('SELECT * FROM logins WHERE state = ?').bind(state).first();
  if (!login || Date.now() - login.created_at > LOGIN_TTL_MS) return fail(410, 'The login expired, start it again');
  if (login.error) {
    await env.DB.prepare('DELETE FROM logins WHERE state = ?').bind(state).run();
    return fail(410, login.error === 'access_denied' ? 'You cancelled the login' : `Login failed: ${login.error}`);
  }
  if (!login.token) return json({ pending: true }, 202);
  await env.DB.prepare('DELETE FROM logins WHERE state = ?').bind(state).run();
  const session = await sessionUser(env, login.token);
  return json({ token: login.token, user: publicUser(session), needsNick: !session.nick });
}

// ---- Sessions ---------------------------------------------------------------------

async function sessionUser(env, token) {
  if (!token) return null;
  return env.DB.prepare(
    'SELECT users.*, sessions.token_hash FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ? AND sessions.expires_at > ?'
  ).bind(await sha256(token), Date.now()).first();
}

const bearer = request => {
  const header = request.headers.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
};

async function me(env, user) {
  const now = Date.now();
  // Using a session keeps it alive for another SESSION_TTL_MS.
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET last_seen = ? WHERE id = ?').bind(now, user.id),
    env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').bind(now + SESSION_TTL_MS, user.token_hash)
  ]);
  return json({ user: publicUser(user), needsNick: !user.nick });
}

async function setNick(env, user, request) {
  let body = {};
  try { body = await request.json(); } catch { /* empty body: no nick */ }
  const problem = nickProblem(body.nick);
  if (problem) return fail(400, problem);
  const nick = cleanNick(body.nick);
  const key = nickKey(nick);
  const taken = await env.DB.prepare('SELECT id FROM users WHERE nick_key = ? AND id != ?').bind(key, user.id).first();
  if (taken) return fail(409, 'That nick is taken');
  try {
    await env.DB.prepare('UPDATE users SET nick = ?, nick_key = ? WHERE id = ?').bind(nick, key, user.id).run();
  } catch {
    return fail(409, 'That nick is taken');
  }
  return json({ user: publicUser({ ...user, nick }), needsNick: false });
}

async function logout(env, user) {
  await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(user.token_hash).run();
  return json({ ok: true });
}

// ---- Routing ----------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname.replace(/\/+$/, '') || '/'}`;
    try {
      switch (route) {
        case 'GET /': return json({ name: 'haxballgh5', ok: true });
        case 'POST /auth/start': return await authStart(env);
        case 'GET /auth/callback': return await authCallback(env, url.searchParams);
        case 'GET /auth/poll': return await authPoll(env, url.searchParams);
      }
      const signedIn = ['GET /me', 'POST /me/nick', 'POST /auth/logout', 'GET /friends', 'POST /presence', 'GET /invites', 'POST /invites', 'POST /invites/dismiss'].includes(route) || route.startsWith('POST /friends/');
      if (!signedIn) return fail(404, 'Not found');
      const user = await sessionUser(env, bearer(request));
      if (!user) return fail(401, 'Your session expired, sign in again');
      switch (route) {
        case 'GET /me': return await me(env, user);
        case 'POST /me/nick': return await setNick(env, user, request);
        case 'POST /auth/logout': return await logout(env, user);
      }
      return (await friendsRoute(env, user, request.method, url.pathname.replace(/\/+$/, ''), request)) || fail(404, 'Not found');
    } catch (err) {
      console.error(route, err);
      return fail(500, 'Server error');
    }
  }
};
