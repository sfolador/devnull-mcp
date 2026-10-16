/**
 * HTTP client for /dev/null: the two CLI endpoints (plain text) and the public v1 API (JSON).
 */
import { DevNullError, sanitize, validateBaseUrl } from './protocol.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ClientOptions {
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export interface ListCommitsOptions {
  replies?: boolean;
  cursor?: string;
}

export class DevNullClient {
  readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = validateBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /** Asks which of our public keys belongs to a /dev/null user. The answer must be one of the candidates. */
  async lookupKey(candidateIds: string[]): Promise<string> {
    if (candidateIds.length === 0) {
      throw new DevNullError('No Ed25519 or RSA SSH key found in your SSH agent or in ~/.ssh.');
    }
    const text = await this.postText('/api/cli/key-lookups', candidateIds.join('\n') + '\n');
    const [type, blob] = text.trim().split(/\s+/);
    const answer = `${type} ${blob}`;
    if (!candidateIds.includes(answer)) {
      throw new DevNullError(`Unexpected answer from ${this.baseUrl}.`);
    }
    return answer;
  }

  /** Sends the signed payload. Returns the server's plain-text confirmation (it contains the commit link). */
  async commit(payload: string, signature: string): Promise<string> {
    const text = await this.postText('/api/cli/commits', payload, { 'X-SSH-Signature': signature });
    return sanitize(text).trim();
  }

  user(username: string): Promise<unknown> {
    return this.getJson(`/api/v1/users/${encodeURIComponent(username)}`);
  }

  userCommits(username: string, options: ListCommitsOptions = {}): Promise<unknown> {
    const params = new URLSearchParams();
    if (options.replies) params.set('replies', '1');
    if (options.cursor) params.set('cursor', options.cursor);
    const query = params.size > 0 ? `?${params.toString()}` : '';
    return this.getJson(`/api/v1/users/${encodeURIComponent(username)}/commits${query}`);
  }

  showCommit(id: string): Promise<unknown> {
    return this.getJson(`/api/v1/commits/${encodeURIComponent(id)}`);
  }

  private async postText(path: string, body: string, headers: Record<string, string> = {}): Promise<string> {
    const response = await this.send(path, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=utf-8', Accept: 'text/plain', ...headers },
      body,
    });
    const text = await response.text();
    if (!response.ok) {
      const detail = sanitize(text).trim();
      throw new DevNullError(detail !== '' ? detail : `Unexpected answer from ${this.baseUrl} (HTTP ${response.status}).`);
    }
    return text;
  }

  private async getJson(path: string): Promise<unknown> {
    const response = await this.send(path, { method: 'GET', headers: { Accept: 'application/json' } });
    const text = await response.text();
    let parsed: unknown = undefined;
    try {
      parsed = text === '' ? undefined : JSON.parse(text);
    } catch {
      // handled below
    }
    if (!response.ok) {
      const message =
        parsed && typeof parsed === 'object' && 'message' in parsed && typeof (parsed as { message: unknown }).message === 'string'
          ? (parsed as { message: string }).message
          : `HTTP ${response.status}`;
      throw new DevNullError(`${this.baseUrl}${path}: ${sanitize(message)}`);
    }
    if (parsed === undefined) throw new DevNullError(`Unexpected answer from ${this.baseUrl}${path}: not JSON.`);
    return parsed;
  }

  private async send(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        redirect: 'error',
        signal: controller.signal,
      });
    } catch (error) {
      const reason = describeFetchError(error);
      throw new DevNullError(`Could not reach ${this.baseUrl}: ${reason}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** "fetch failed" alone says nothing: add the underlying cause (DNS, TLS, connection reset...). */
function describeFetchError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const code = (cause as { code?: string }).code;
    return `${error.message} (${code ? `${code}: ` : ''}${cause.message})`;
  }
  return error.message;
}
