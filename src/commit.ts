/**
 * The commit flow: find a key /dev/null knows, sign the payload with it, send it.
 */
import { randomBytes } from 'node:crypto';

import type { DevNullClient } from './client.js';
import type { KeyCandidate } from './keys.js';
import { discoverKeys, type KeyDiscoveryOptions } from './keys.js';
import { buildPayload, DevNullError, validateMessage, validateReplyTo } from './protocol.js';
import { signPayload } from './sign.js';

export interface CommitRequest {
  message: string;
  replyTo?: string;
}

export interface CommitDeps {
  client: DevNullClient;
  keyOptions?: KeyDiscoveryOptions;
  sign?: typeof signPayload;
  now?: () => number;
  nonce?: () => string;
}

/** Resolves (and remembers for the life of the process) the local key that /dev/null recognizes. */
export class KeyResolver {
  private resolved: KeyCandidate | null = null;

  constructor(
    private readonly client: DevNullClient,
    private readonly options: KeyDiscoveryOptions = {},
  ) {}

  async resolve(): Promise<KeyCandidate> {
    if (this.resolved) return this.resolved;
    const candidates = await discoverKeys(this.options);
    const id = await this.client.lookupKey(candidates.map((candidate) => candidate.id));
    const key = candidates.find((candidate) => candidate.id === id);
    if (!key) throw new DevNullError(`Unexpected answer from ${this.client.baseUrl}.`);
    this.resolved = key;
    return key;
  }

  forget(): void {
    this.resolved = null;
  }
}

export async function commitToDevNull(request: CommitRequest, deps: CommitDeps, resolver?: KeyResolver): Promise<string> {
  const message = validateMessage(request.message);
  const replyTo = validateReplyTo(request.replyTo);

  const keys = resolver ?? new KeyResolver(deps.client, deps.keyOptions);
  const key = await keys.resolve();

  const payload = buildPayload({
    timestamp: (deps.now ?? (() => Math.floor(Date.now() / 1000)))(),
    nonce: (deps.nonce ?? (() => randomBytes(16).toString('hex')))(),
    replyTo,
    message,
  });

  const signature = await (deps.sign ?? signPayload)(payload, key);
  try {
    return await deps.client.commit(payload, signature);
  } catch (error) {
    // A key the server stopped recognizing should be looked up again next time.
    if (error instanceof DevNullError && /SSH key .* is not on the GitHub account/.test(error.message)) keys.forget();
    throw error;
  }
}
