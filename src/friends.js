// Friends, with "Authorization: Bearer <token>" (see index.js):
//   GET  /friends                 -> { friends, incoming, outgoing, blocked }
//   POST /friends/request { nick } -> sends a request (or accepts theirs, if they asked first)
//   POST /friends/accept|decline|cancel|remove|block|unblock { id }
//   POST /presence { room: { name, link, players, max } | null, playing } | { offline: true }
//        -> also { notices: { invites, requests } }: what the app shows as notices
//   POST /invites { to, kind: 'room' | 'watch', room: { name, link }, password? }
//   GET  /invites, POST /invites/dismiss { id }
//   POST /messages { to, body }; GET /messages?with=<id>&before=<id> (marks theirs read)
//   GET  /notices: the notices alone, without sending presence
// Other players are shown by nick and Discord picture only. Someone who blocked
// you cannot be found, and you never learn that they did. Friends also see
// whether you are online and in which room (the app sends it every
// HEARTBEAT_MS); a player who stops sending is offline after ONLINE_MS.

import { nickKey } from './nick.js';

const MAX_OUTGOING = 50;
const MAX_FRIENDS = 300;
export const HEARTBEAT_MS = 15_000;
const INVITE_TTL_MS = 10 * 60 * 1000;
const INVITE_KINDS = ['room', 'watch'];
const MESSAGE_MAX = 500;
const MESSAGE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MESSAGES_PER_MINUTE = 20;
const THREAD_PAGE = 50;
const ONLINE_MS = 45_000;
const ROOM_LINK = /^https:\/\/www\.haxball\.com\/play\?c=[A-Za-z0-9_-]{4,20}(&p=1)?$/;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const fail = (status, error) => json({ error }, status);

const avatarUrl = row => (row.discord_avatar ? `https://cdn.discordapp.com/avatars/${row.discord_id}/${row.discord_avatar}.png?size=64` : null);
const player = (row, at) => ({ id: row.id, nick: row.nick, avatar: avatarUrl(row), at });

// A friend's presence: online (and the room, if any), or when they were last seen.
function presenceOf(row, now) {
  const fresh = row.p_updated && now - row.p_updated < ONLINE_MS;
  if (!fresh || !row.p_online) return { online: false, lastSeen: Math.max(row.p_updated || 0, row.last_seen || 0) || null };
  const room = row.p_room ? { name: row.p_room, link: row.p_link || null, players: row.p_players, max: row.p_max, playing: Boolean(row.p_playing) } : null;
  return { online: true, room };
}

async function list(env, me) {
  const rows = (sql, ...args) => env.DB.prepare(sql).bind(...args).all().then(r => r.results);
  const [friends, incoming, outgoing, blocked] = await Promise.all([
    rows('SELECT u.*, f.since AS at, p.online AS p_online, p.room_name AS p_room, p.room_link AS p_link, p.players AS p_players, p.max_players AS p_max, p.playing AS p_playing, p.updated_at AS p_updated ' +
      'FROM friendships f JOIN users u ON u.id = f.friend_id LEFT JOIN presence p ON p.user_id = u.id WHERE f.user_id = ? ORDER BY u.nick_key', me.id),
    rows('SELECT u.*, r.created_at AS at FROM friend_requests r JOIN users u ON u.id = r.from_id WHERE r.to_id = ? ORDER BY r.created_at DESC', me.id),
    rows('SELECT u.*, r.created_at AS at FROM friend_requests r JOIN users u ON u.id = r.to_id WHERE r.from_id = ? ORDER BY r.created_at DESC', me.id),
    rows('SELECT u.*, b.created_at AS at FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.user_id = ? ORDER BY u.nick_key', me.id)
  ]);
  const map = list => list.map(row => player(row, row.at));
  const now = Date.now();
  return json({
    friends: friends.map(row => ({ ...player(row, row.at), presence: presenceOf(row, now) })),
    incoming: map(incoming),
    outgoing: map(outgoing),
    blocked: map(blocked),
    heartbeatMs: HEARTBEAT_MS
  });
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

// The app says what the player is doing; { offline: true } when it closes or
// stops sharing.
async function setPresence(env, me, body) {
  const now = Date.now();
  const r = body && typeof body.room === 'object' && body.room ? body.room : null;
  const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);
  const small = v => (Number.isInteger(v) && v >= 0 && v <= 100 ? v : null);
  const online = body.offline === true ? 0 : 1;
  const room = online && r && text(r.name, 100) ? r : null;
  await env.DB.prepare(
    'INSERT INTO presence (user_id, online, room_name, room_link, players, max_players, playing, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ' +
    'ON CONFLICT(user_id) DO UPDATE SET online = ?2, room_name = ?3, room_link = ?4, players = ?5, max_players = ?6, playing = ?7, updated_at = ?8'
  ).bind(
    me.id, online,
    room ? text(room.name, 100) : null,
    room && ROOM_LINK.test(room.link) ? room.link : null,
    room ? small(room.players) : null,
    room ? small(room.max) : null,
    room && body.playing === true ? 1 : 0,
    now
  ).run();
  return json({ ok: true, heartbeatMs: HEARTBEAT_MS, notices: online ? await notices(env, me, now) : null });
}

// ---- Invitations ----------------------------------------------------------------------

async function incomingInvites(env, me, now) {
  const { results } = await env.DB.prepare(
    'SELECT i.*, u.nick, u.discord_id, u.discord_avatar, u.id AS uid FROM invites i JOIN users u ON u.id = i.from_id ' +
    'WHERE i.to_id = ? AND i.expires_at > ? ORDER BY i.created_at DESC'
  ).bind(me.id, now).all();
  return results.map(r => ({
    id: r.id,
    from: { id: r.uid, nick: r.nick, avatar: avatarUrl(r) },
    kind: r.kind,
    room: { name: r.room_name, link: r.room_link },
    password: r.password || null,
    at: r.created_at,
    expiresAt: r.expires_at
  }));
}

// Unread messages, by sender: how many and the last one.
async function unreadMessages(env, me) {
  const { results } = await env.DB.prepare(
    'SELECT m.from_id, COUNT(*) AS n, MAX(m.id) AS last_id, u.nick, u.discord_id, u.discord_avatar, u.id AS uid ' +
    'FROM messages m JOIN users u ON u.id = m.from_id WHERE m.to_id = ? AND m.read_at IS NULL GROUP BY m.from_id'
  ).bind(me.id).all();
  if (!results.length) return [];
  const lasts = await env.DB.prepare(`SELECT id, body, created_at FROM messages WHERE id IN (${results.map(() => '?').join(',')})`).bind(...results.map(r => r.last_id)).all();
  const byId = new Map(lasts.results.map(m => [m.id, m]));
  return results.map(r => ({
    from: { id: r.uid, nick: r.nick, avatar: avatarUrl(r) },
    count: r.n,
    last: { id: r.last_id, body: byId.get(r.last_id).body.slice(0, 200), at: byId.get(r.last_id).created_at }
  }));
}

// What the app shows as notices: invitations, how many friend requests wait,
// and unread messages.
async function notices(env, me, now) {
  const [invites, requests, messages] = await Promise.all([
    incomingInvites(env, me, now),
    count(env, 'SELECT COUNT(*) AS n FROM friend_requests WHERE to_id = ?', me.id),
    unreadMessages(env, me)
  ]);
  return { invites, requests, messages };
}

// ---- Messages ---------------------------------------------------------------------------

async function sendMessage(env, me, body) {
  const to = Number(body.to);
  const text = typeof body.body === 'string' ? body.body.replace(/\r\n?/g, '\n').trim().slice(0, MESSAGE_MAX) : '';
  if (!Number.isInteger(to) || !text) return fail(400, 'Write something');
  if (!(await count(env, 'SELECT COUNT(*) AS n FROM friendships WHERE user_id = ? AND friend_id = ?', me.id, to))) return fail(403, 'You can only write to friends');
  const now = Date.now();
  if (await count(env, 'SELECT COUNT(*) AS n FROM messages WHERE from_id = ? AND created_at > ?', me.id, now - 60_000) >= MESSAGES_PER_MINUTE) {
    return fail(429, 'Too many messages, wait a moment');
  }
  const result = await env.DB.batch([
    env.DB.prepare('DELETE FROM messages WHERE created_at < ?').bind(now - MESSAGE_TTL_MS),
    env.DB.prepare('INSERT INTO messages (from_id, to_id, body, created_at) VALUES (?, ?, ?, ?)').bind(me.id, to, text, now)
  ]);
  return json({ ok: true, message: { id: result[1].meta.last_row_id, mine: true, body: text, at: now } });
}

// The conversation with a friend, oldest first: the last THREAD_PAGE messages
// (before message id `before`, for older ones). Their messages become read.
async function thread(env, me, params) {
  const other = Number(params.get('with'));
  const before = Number(params.get('before')) || Number.MAX_SAFE_INTEGER;
  if (!Number.isInteger(other)) return fail(400, 'Unknown player');
  const { results } = await env.DB.prepare(
    'SELECT * FROM messages WHERE ((from_id = ?1 AND to_id = ?2) OR (from_id = ?2 AND to_id = ?1)) AND id < ?3 ORDER BY id DESC LIMIT ?4'
  ).bind(me.id, other, before, THREAD_PAGE).all();
  await env.DB.prepare('UPDATE messages SET read_at = ? WHERE to_id = ? AND from_id = ? AND read_at IS NULL').bind(Date.now(), me.id, other).run();
  return json({
    messages: results.reverse().map(m => ({ id: m.id, mine: m.from_id === me.id, body: m.body, at: m.created_at, read: m.from_id === me.id ? m.read_at !== null : true })),
    more: results.length === THREAD_PAGE
  });
}

async function invite(env, me, body) {
  const to = Number(body.to);
  const room = body.room && typeof body.room === 'object' ? body.room : {};
  const name = typeof room.name === 'string' ? room.name.slice(0, 100) : '';
  if (!Number.isInteger(to) || !INVITE_KINDS.includes(body.kind)) return fail(400, 'Bad invitation');
  if (!name || !ROOM_LINK.test(room.link)) return fail(400, 'Your room has no link to share');
  if (!(await count(env, 'SELECT COUNT(*) AS n FROM friendships WHERE user_id = ? AND friend_id = ?', me.id, to))) return fail(403, 'You can only invite friends');
  const password = typeof body.password === 'string' && body.password ? body.password.slice(0, 30) : null;
  const now = Date.now();
  await env.DB.batch([
    // A new invitation replaces the last one to that friend, with a new id (so it shows again).
    env.DB.prepare('DELETE FROM invites WHERE expires_at <= ? OR (from_id = ? AND to_id = ?)').bind(now, me.id, to),
    env.DB.prepare('INSERT INTO invites (from_id, to_id, kind, room_name, room_link, password, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(me.id, to, body.kind, name, room.link, password, now, now + INVITE_TTL_MS)
  ]);
  return json({ ok: true, expiresInMs: INVITE_TTL_MS });
}

// Routes this module answers, for a signed-in user; null when the route is not one.
export async function friendsRoute(env, me, method, path, request) {
  if (method === 'GET' && path === '/friends') return list(env, me);
  if (method === 'POST' && path === '/presence') {
    let body = {};
    try { body = await request.json(); } catch { /* empty body */ }
    return setPresence(env, me, body);
  }
  if (method === 'GET' && path === '/invites') return json({ invites: await incomingInvites(env, me, Date.now()) });
  // The notices on their own, for an app that does not share its presence.
  if (method === 'GET' && path === '/notices') return json({ notices: await notices(env, me, Date.now()) });
  if (method === 'GET' && path === '/messages') return thread(env, me, new URL(request.url).searchParams);
  if (method === 'POST' && path === '/messages') {
    let body = {};
    try { body = await request.json(); } catch { /* empty body */ }
    return sendMessage(env, me, body);
  }
  if (method === 'POST' && (path === '/invites' || path === '/invites/dismiss')) {
    let body = {};
    try { body = await request.json(); } catch { /* empty body */ }
    if (path === '/invites') return invite(env, me, body);
    await env.DB.prepare('DELETE FROM invites WHERE id = ? AND to_id = ?').bind(Number(body.id) || 0, me.id).run();
    return json({ ok: true });
  }
  if (method !== 'POST' || !path.startsWith('/friends/')) return null;
  let body = {};
  try { body = await request.json(); } catch { /* empty body */ }
  const action = path.slice('/friends/'.length);
  return action === 'request' ? sendRequest(env, me, body) : act(env, me, action, body);
}
