/**
 * The /dev/null CLI commit protocol, as implemented by https://dev-null.sh/commit and verified
 * server-side by app/Services/SignedCommits.php in nunomaduro/dev-null.sh.
 *
 * Everything here is pure: no I/O, no process spawning.
 */

export const NAMESPACE = 'devnull-commit';
export const DEFAULT_BASE_URL = 'https://dev-null.sh';
export const MIN_BODY_LENGTH = 3;
export const MAX_BODY_LENGTH = 4000;

const ACCEPTED_KEY_TYPES = new Set(['ssh-ed25519', 'ssh-rsa']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class DevNullError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DevNullError';
  }
}

/** "<type> <base64>" from an authorized_keys-style line, or null when it is not an Ed25519/RSA key. */
export function keyId(line: string): string | null {
  const [type, blob] = line.trim().split(/\s+/);
  if (!type || !blob || !ACCEPTED_KEY_TYPES.has(type)) return null;
  if (!/^[A-Za-z0-9+/=]+$/.test(blob)) return null;
  return `${type} ${blob}`;
}

/** Key ids from many lines, deduplicated, in first-seen order. */
export function uniqueKeyIds(lines: Iterable<string>): string[] {
  const seen = new Set<string>();
  for (const line of lines) {
    const id = keyId(line);
    if (id) seen.add(id);
  }
  return [...seen];
}

/** The reply target goes on its own line of the signed payload, so it must be a single safe token. */
export function validateReplyTo(replyTo: string | undefined): string {
  const value = (replyTo ?? '').trim();
  if (value === '') return '';
  if (!/^[A-Za-z0-9:/._@-]+$/.test(value)) {
    throw new DevNullError('reply_to must be the hash of a commit or its link.');
  }
  return value;
}

export function validateMessage(message: string): string {
  if (typeof message !== 'string') throw new DevNullError('message must be a string.');
  const trimmed = message.trim();
  if (trimmed === '') throw new DevNullError('Aborting commit due to empty commit message.');
  if ([...trimmed].length < MIN_BODY_LENGTH) {
    throw new DevNullError(`The commit message must be at least ${MIN_BODY_LENGTH} characters.`);
  }
  if ([...trimmed].length > MAX_BODY_LENGTH) {
    throw new DevNullError(`The commit message must be at most ${MAX_BODY_LENGTH} characters.`);
  }
  return message;
}

export interface PayloadParts {
  /** Unix seconds. */
  timestamp: number;
  /** 32 lowercase hex chars. */
  nonce: string;
  replyTo: string;
  message: string;
}

/** Exactly what the script signs: timestamp, nonce, reply target and message, newline separated, no trailing newline. */
export function buildPayload({ timestamp, nonce, replyTo, message }: PayloadParts): string {
  if (!Number.isInteger(timestamp) || timestamp < 0) throw new DevNullError('Invalid timestamp.');
  if (!/^[0-9a-f]{32}$/.test(nonce)) throw new DevNullError('Invalid nonce.');
  if (replyTo.includes('\n')) throw new DevNullError('Invalid reply target.');
  return `${timestamp}\n${nonce}\n${replyTo}\n${message}`;
}

/** Base64 body of an OpenSSH armored signature file (the `-----` lines removed, newlines joined). */
export function extractSignature(sigFile: string): string {
  const signature = sigFile
    .split('\n')
    .filter((line) => !line.includes('-----'))
    .join('')
    .trim();
  if (signature === '' || !/^[A-Za-z0-9+/=]+$/.test(signature)) {
    throw new DevNullError('ssh-keygen produced an unexpected signature.');
  }
  return signature;
}

/** Only https, or plain http to localhost, is ever used. Returns the URL without a trailing slash. */
export function validateBaseUrl(raw: string | undefined): string {
  const value = (raw ?? DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DevNullError(`Refusing to use ${value}: it is not a valid URL.`);
  }
  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol === 'https:' || (url.protocol === 'http:' && isLocal)) return value;
  throw new DevNullError(`Refusing to send your commit to ${value}: it is not an https:// URL.`);
}

export function validateUsername(username: string): string {
  const value = username.trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(value)) {
    throw new DevNullError('username must be a GitHub username (letters, digits and dashes).');
  }
  return value;
}

/** A commit UUID from the UUID itself or from a /dev/null commit link. */
export function commitIdFromReference(reference: string): string {
  const value = reference.trim();
  if (UUID_RE.test(value)) return value.toLowerCase();
  const match = value.match(/\/commits\/([0-9a-f-]{36})/i);
  if (match) return match[1].toLowerCase();
  throw new DevNullError('commit must be a commit UUID or a /dev/null commit link.');
}

/** Removes control characters (such as terminal escape sequences) from text the server sends. */
export function sanitize(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '');
}
