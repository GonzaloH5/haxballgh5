// Nicks: 3-20 letters (any alphabet), digits, spaces, _ . -; unique ignoring case
// and look-alike forms (NFKC). Pure, shared by the Worker and its tests.

export const NICK_MIN = 3;
export const NICK_MAX = 20;
const ALLOWED = /^[\p{L}\p{N}_.\- ]+$/u;
const RESERVED = new Set(['admin', 'administrator', 'haxball', 'haxballgh5', 'moderator', 'mod', 'system', 'support', 'staff', 'host']);

export function cleanNick(raw) {
  return typeof raw === 'string' ? raw.normalize('NFKC').replace(/\s+/g, ' ').trim() : '';
}

export const nickKey = nick => cleanNick(nick).toLowerCase();

// Returns an error message for the user, or null when the nick is fine.
export function nickProblem(raw) {
  const nick = cleanNick(raw);
  const length = [...nick].length;
  if (length < NICK_MIN || length > NICK_MAX) return `The nick must be ${NICK_MIN} to ${NICK_MAX} characters`;
  if (!ALLOWED.test(nick)) return 'Use letters, numbers, spaces, _ . or -';
  if (RESERVED.has(nickKey(nick))) return 'That nick is reserved';
  return null;
}
