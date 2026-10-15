// Groups (parties), with "Authorization: Bearer <token>":
//   GET  /party                       -> { party: { id, rev, leaderId, members, invited, call, messages } | null, invites }
//   POST /party/invite { to }          -> (leader) invites a friend; makes the group if there is none
//   POST /party/accept|decline { partyId }
//   POST /party/leave, /party/kick { id }, /party/lead { id }
//   POST /party/msg { body }           -> group chat
//   POST /party/call { room: { name, link }, password? } | { room: null }  -> (leader) calls the group to a room
// The presence answer carries partyNotice(): the group's rev, the call and the
// invitations, so the app fetches the group only when it changed.

const MAX_MEMBERS = 8;
const INVITE_TTL_MS = 10 * 60 * 1000;
const CALL_TTL_MS = 10 * 60 * 1000;
const MESSAGE_MAX = 300;
const MESSAGES_KEPT = 100;
const ROOM_LINK = /^https:\/\/www\.haxball\.com\/play\?c=[A-Za-z0-9_-]{4,20}(&p=1)?$/;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const fail = (status, error) => json({ error }, status);
const avatarUrl = row => (row.discord_avatar ? `https://cdn.discordapp.com/avatars/${row.discord_id}/${row.discord_avatar}.png?size=64` : null);
const player = row => ({ id: row.id, nick: row.nick, avatar: avatarUrl(row) });

const first = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).first();
const all = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).all().then(r => r.results);
const bump = (env, partyId) => env.DB.prepare('UPDATE parties SET rev = rev + 1 WHERE id = ?').bind(partyId);

const myParty = (env, me) => first(env, 'SELECT p.* FROM party_members m JOIN parties p ON p.id = m.party_id WHERE m.user_id = ?', me.id);

async function incomingInvites(env, me, now) {
  const rows = await all(env,
    'SELECT i.party_id, i.created_at, u.* FROM party_invites i JOIN users u ON u.id = i.from_id WHERE i.to_id = ? AND i.created_at > ? ORDER BY i.created_at DESC',
    me.id, now - INVITE_TTL_MS);
  return rows.map(r => ({ partyId: r.party_id, from: player(r), at: r.created_at }));
}

async function view(env, me) {
  const now = Date.now();
  const party = await myParty(env, me);
  const invites = await incomingInvites(env, me, now);
  if (!party) return json({ party: null, invites });
  const [members, invited, messages] = await Promise.all([
    all(env, 'SELECT u.*, m.joined_at FROM party_members m JOIN users u ON u.id = m.user_id WHERE m.party_id = ? ORDER BY m.joined_at', party.id),
    all(env, 'SELECT u.* FROM party_invites i JOIN users u ON u.id = i.to_id WHERE i.party_id = ? AND i.created_at > ?', party.id, now - INVITE_TTL_MS),
    all(env, 'SELECT * FROM (SELECT * FROM party_messages WHERE party_id = ? ORDER BY id DESC LIMIT 50) ORDER BY id', party.id)
  ]);
  const nicks = new Map(members.map(m => [m.id, m.nick]));
  return json({
    party: {
      id: party.id,
      rev: party.rev,
      leaderId: party.leader_id,
      members: members.map(player),
      invited: invited.map(player),
      call: callOf(party, now),
      messages: messages.map(m => ({ id: m.id, fromId: m.from_id, nick: nicks.get(m.from_id) || '(left)', body: m.body, at: m.created_at }))
    },
    invites
  });
}

const callOf = (party, now) => (party.call_at && now - party.call_at < CALL_TTL_MS
  ? { name: party.call_name, link: party.call_link, password: party.call_password || null, at: party.call_at }
  : null);

// For the presence answer: enough for the app to know what changed.
export async function partyNotice(env, me, now) {
  const party = await myParty(env, me);
  const invites = await incomingInvites(env, me, now);
  if (!party) return { id: null, rev: 0, call: null, invites };
  const call = callOf(party, now);
  return { id: party.id, rev: party.rev, leaderId: party.leader_id, call: call && party.leader_id !== me.id ? call : null, invites };
}

async function areFriends(env, a, b) {
  return Boolean(await first(env, 'SELECT 1 AS ok FROM friendships WHERE user_id = ? AND friend_id = ?', a, b));
}

// Leaving: the group goes on with the oldest member as leader, or ends when empty.
async function leave(env, userId, party) {
  await env.DB.prepare('DELETE FROM party_members WHERE user_id = ?').bind(userId).run();
  const next = await first(env, 'SELECT user_id FROM party_members WHERE party_id = ? ORDER BY joined_at LIMIT 1', party.id);
  if (!next) {
    await env.DB.prepare('DELETE FROM parties WHERE id = ?').bind(party.id).run();
    return;
  }
  const leader = party.leader_id === userId ? next.user_id : party.leader_id;
  await env.DB.batch([
    env.DB.prepare('UPDATE parties SET leader_id = ?, rev = rev + 1 WHERE id = ?').bind(leader, party.id)
  ]);
}

async function act(env, me, action, body) {
  const now = Date.now();
  let party = await myParty(env, me);
  const isLeader = party && party.leader_id === me.id;
  switch (action) {
    case 'invite': {
      const to = Number(body.to);
      if (!Number.isInteger(to) || to === me.id) return fail(400, 'Unknown player');
      if (!(await areFriends(env, me.id, to))) return fail(403, 'You can only invite friends');
      if (party && !isLeader) return fail(403, 'Only the leader invites');
      if (!party) {
        const made = await env.DB.prepare('INSERT INTO parties (leader_id, created_at) VALUES (?, ?)').bind(me.id, now).run();
        const partyId = made.meta.last_row_id;
        await env.DB.prepare('INSERT INTO party_members (user_id, party_id, joined_at) VALUES (?, ?, ?)').bind(me.id, partyId, now).run();
        party = await myParty(env, me);
      }
      if (await first(env, 'SELECT 1 AS ok FROM party_members WHERE user_id = ? AND party_id = ?', to, party.id)) return fail(409, 'Already in your group');
      const size = await first(env, 'SELECT COUNT(*) AS n FROM party_members WHERE party_id = ?', party.id);
      if (size.n >= MAX_MEMBERS) return fail(409, `A group has at most ${MAX_MEMBERS} players`);
      await env.DB.batch([
        env.DB.prepare('INSERT OR REPLACE INTO party_invites (party_id, to_id, from_id, created_at) VALUES (?, ?, ?, ?)').bind(party.id, to, me.id, now),
        bump(env, party.id)
      ]);
      break;
    }
    case 'accept': {
      const partyId = Number(body.partyId);
      const invite = await first(env, 'SELECT * FROM party_invites WHERE party_id = ? AND to_id = ? AND created_at > ?', partyId, me.id, now - INVITE_TTL_MS);
      if (!invite) return fail(404, 'That invitation is gone');
      const size = await first(env, 'SELECT COUNT(*) AS n FROM party_members WHERE party_id = ?', partyId);
      if (!size.n) return fail(404, 'That group no longer exists');
      if (size.n >= MAX_MEMBERS) return fail(409, 'That group is full');
      if (party) await leave(env, me.id, party);
      await env.DB.batch([
        env.DB.prepare('INSERT INTO party_members (user_id, party_id, joined_at) VALUES (?, ?, ?)').bind(me.id, partyId, now),
        env.DB.prepare('DELETE FROM party_invites WHERE to_id = ? AND party_id = ?').bind(me.id, partyId),
        bump(env, partyId)
      ]);
      break;
    }
    case 'decline':
      await env.DB.prepare('DELETE FROM party_invites WHERE to_id = ? AND party_id = ?').bind(me.id, Number(body.partyId)).run();
      break;
    case 'leave':
      if (!party) return fail(404, 'You are not in a group');
      await leave(env, me.id, party);
      break;
    case 'kick':
    case 'lead': {
      const id = Number(body.id);
      if (!isLeader) return fail(403, 'Only the leader can do that');
      if (id === me.id || !(await first(env, 'SELECT 1 AS ok FROM party_members WHERE user_id = ? AND party_id = ?', id, party.id))) return fail(404, 'Not in your group');
      if (action === 'kick') await leave(env, id, party);
      else await env.DB.batch([env.DB.prepare('UPDATE parties SET leader_id = ? WHERE id = ?').bind(id, party.id), bump(env, party.id)]);
      break;
    }
    case 'msg': {
      if (!party) return fail(404, 'You are not in a group');
      const text = typeof body.body === 'string' ? body.body.trim().slice(0, MESSAGE_MAX) : '';
      if (!text) return fail(400, 'Write something');
      const recent = await first(env, 'SELECT COUNT(*) AS n FROM party_messages WHERE from_id = ? AND created_at > ?', me.id, now - 60_000);
      if (recent.n >= 20) return fail(429, 'Too many messages, wait a moment');
      await env.DB.batch([
        env.DB.prepare('INSERT INTO party_messages (party_id, from_id, body, created_at) VALUES (?, ?, ?, ?)').bind(party.id, me.id, text, now),
        env.DB.prepare('DELETE FROM party_messages WHERE party_id = ? AND id <= (SELECT id FROM party_messages WHERE party_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)').bind(party.id, party.id, MESSAGES_KEPT),
        bump(env, party.id)
      ]);
      break;
    }
    case 'call': {
      if (!isLeader) return fail(403, 'Only the leader calls the group');
      const room = body.room && typeof body.room === 'object' ? body.room : null;
      if (room && (!room.name || !ROOM_LINK.test(room.link))) return fail(400, 'Your room has no link to share');
      const password = room && typeof body.password === 'string' && body.password ? body.password.slice(0, 30) : null;
      await env.DB.prepare('UPDATE parties SET call_name = ?, call_link = ?, call_password = ?, call_at = ?, rev = rev + 1 WHERE id = ?')
        .bind(room ? String(room.name).slice(0, 100) : null, room ? room.link : null, password, room ? now : null, party.id).run();
      break;
    }
    default:
      return fail(404, 'Not found');
  }
  return view(env, me);
}

export async function partyRoute(env, me, method, path, request) {
  if (method === 'GET' && path === '/party') return view(env, me);
  if (method !== 'POST' || !path.startsWith('/party/')) return null;
  let body = {};
  try { body = await request.json(); } catch { /* empty body */ }
  return act(env, me, path.slice('/party/'.length), body);
}
