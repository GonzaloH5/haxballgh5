// Friends, with "Authorization: Bearer <token>" (see index.js):
//   GET  /friends                 -> { friends, incoming, outgoing, blocked }
//   POST /friends/request { nick } -> sends a request (or accepts theirs, if they asked first)
//   POST /friends/accept|decline|cancel|remove|block|unblock { id }
// Other players are shown by nick and Discord picture only. Someone who blocked
// you cannot be found, and you never learn that they did.

import { nickKey } from './nick.js';

const MAX_OUTGOING = 50;
const MAX_FRIENDS = 300;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const fail = (status, error) => json({ error }, status);

const avatarUrl = row => (row.discord_avatar ? `https://cdn.discordapp.com/avatars/${row.discord_id}/${row.discord_avatar}.png?size=64` : null);
const player = (row, at) => ({ id: row.id, nick: row.nick, avatar: avatarUrl(row), at });

async function list(env, me) {
  const rows = (sql, ...args) => env.DB.prepare(sql).bind(...args).all().then(r => r.results);
  const [friends, incoming, outgoing, blocked] = await Promise.all([
    rows('SELECT u.*, f.since AS at FROM friendships f JOIN users u ON u.id = f.friend_id WHERE f.user_id = ? ORDER BY u.nick_key', me.id),
    rows('SELECT u.*, r.created_at AS at FROM friend_requests r JOIN users u ON u.id = r.from_id WHERE r.to_id = ? ORDER BY r.created_at DESC', me.id),
    rows('SELECT u.*, r.created_at AS at FROM friend_requests r JOIN users u ON u.id = r.to_id WHERE r.from_id = ? ORDER BY r.created_at DESC', me.id),
    rows('SELECT u.*, b.created_at AS at FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.user_id = ? ORDER BY u.nick_key', me.id)
  ]);
  const map = list => list.map(row => player(row, row.at));
  return json({ friends: map(friends), incoming: map(incoming), outgoing: map(outgoing), blocked: map(blocked) });
}

async function befriend(env, a, b) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO friendships (user_id, friend_id, since) VALUES (?, ?, ?), (?, ?, ?)').bind(a, b, now, b, a, now),
    env.DB.prepare('DELETE FROM friend_requests WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)').bind(a, b, b, a)
  ]);
}

const count = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).first().then(r => r.n);

async function sendRequest(env, me, body) {
  if (!me.nick) return fail(403, 'Choose a nick first');
  const notFound = fail(404, 'No player with that nick');
  const target = await env.DB.prepare('SELECT * FROM users WHERE nick_key = ?').bind(nickKey(body.nick)).first();
  if (!target) return notFound;
  if (target.id === me.id) return fail(400, 'That is you');
  if (await count(env, 'SELECT COUNT(*) AS n FROM blocks WHERE user_id = ? AND blocked_id = ?', target.id, me.id)) return notFound;
  if (await count(env, 'SELECT COUNT(*) AS n FROM blocks WHERE user_id = ? AND blocked_id = ?', me.id, target.id)) return fail(409, 'You blocked that player; unblock them first');
  if (await count(env, 'SELECT COUNT(*) AS n FROM friendships WHERE user_id = ? AND friend_id = ?', me.id, target.id)) return fail(409, 'You are already friends');
  if (await count(env, 'SELECT COUNT(*) AS n FROM friend_requests WHERE from_id = ? AND to_id = ?', target.id, me.id)) {
    await befriend(env, me.id, target.id);
    return json({ ok: true, accepted: true, nick: target.nick });
  }
  if (await count(env, 'SELECT COUNT(*) AS n FROM friendships WHERE user_id = ?', me.id) >= MAX_FRIENDS) return fail(409, `You have ${MAX_FRIENDS} friends already`);
  if (await count(env, 'SELECT COUNT(*) AS n FROM friend_requests WHERE from_id = ?', me.id) >= MAX_OUTGOING) return fail(429, 'Too many requests waiting; cancel some first');
  await env.DB.prepare('INSERT OR IGNORE INTO friend_requests (from_id, to_id, created_at) VALUES (?, ?, ?)').bind(me.id, target.id, Date.now()).run();
  return json({ ok: true, accepted: false, nick: target.nick });
}

async function act(env, me, action, body) {
  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0 || id === me.id) return fail(400, 'Unknown player');
  const run = (sql, ...args) => env.DB.prepare(sql).bind(...args);
  switch (action) {
    case 'accept': {
      if (!(await count(env, 'SELECT COUNT(*) AS n FROM friend_requests WHERE from_id = ? AND to_id = ?', id, me.id))) return fail(404, 'That request is gone');
      await befriend(env, me.id, id);
      break;
    }
    case 'decline':
      await run('DELETE FROM friend_requests WHERE from_id = ? AND to_id = ?', id, me.id).run();
      break;
    case 'cancel':
      await run('DELETE FROM friend_requests WHERE from_id = ? AND to_id = ?', me.id, id).run();
      break;
    case 'remove':
      await run('DELETE FROM friendships WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)', me.id, id, id, me.id).run();
      break;
    case 'block': {
      if (!(await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(id).first())) return fail(404, 'Unknown player');
      // Blocking ends the friendship and any request, both ways.
      await env.DB.batch([
        run('INSERT OR IGNORE INTO blocks (user_id, blocked_id, created_at) VALUES (?, ?, ?)', me.id, id, Date.now()),
        run('DELETE FROM friendships WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)', me.id, id, id, me.id),
        run('DELETE FROM friend_requests WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)', me.id, id, id, me.id)
      ]);
      break;
    }
    case 'unblock':
      await run('DELETE FROM blocks WHERE user_id = ? AND blocked_id = ?', me.id, id).run();
      break;
    default:
      return fail(404, 'Not found');
  }
  return list(env, me);
}

// Routes this module answers, for a signed-in user; null when the route is not one.
export async function friendsRoute(env, me, method, path, request) {
  if (method === 'GET' && path === '/friends') return list(env, me);
  if (method !== 'POST' || !path.startsWith('/friends/')) return null;
  let body = {};
  try { body = await request.json(); } catch { /* empty body */ }
  const action = path.slice('/friends/'.length);
  return action === 'request' ? sendRequest(env, me, body) : act(env, me, action, body);
}
