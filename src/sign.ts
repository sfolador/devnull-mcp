/**
 * Signs a payload with `ssh-keygen -Y sign` in the devnull-commit namespace. ssh-keygen (or the
 * SSH agent) handles the private key; this module never reads one. Temporary files live in a fresh
 * private directory that is removed afterwards.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { KeyCandidate } from './keys.js';
import { DevNullError, extractSignature, NAMESPACE, sanitize } from './protocol.js';

const execFileAsync = promisify(execFile);

export interface SignOptions {
  /** Milliseconds before giving up (a passphrase prompt with no terminal would otherwise hang). */
  timeoutMs?: number;
}

export async function signPayload(payload: string, key: KeyCandidate, options: SignOptions = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'devnull-mcp-'));
  try {
    const payloadPath = join(dir, 'commit');
    await writeFile(payloadPath, payload, { encoding: 'utf8', mode: 0o600 });

    let keyPath: string;
    if (key.source === 'agent') {
      keyPath = join(dir, 'key.pub');
      await writeFile(keyPath, `${key.id}\n`, { encoding: 'utf8', mode: 0o600 });
    } else if (key.privateKeyPath) {
      keyPath = key.privateKeyPath;
    } else {
      throw new DevNullError(`Could not find the private key of ${key.id}.`);
    }

    try {
      await execFileAsync('ssh-keygen', ['-Y', 'sign', '-n', NAMESPACE, '-f', keyPath, payloadPath], {
        timeout: options.timeoutMs ?? 20_000,
        env: { ...process.env, SSH_ASKPASS_REQUIRE: 'never' },
        encoding: 'utf8',
      });
    } catch (error) {
      const stderr = sanitize(String((error as { stderr?: string }).stderr ?? (error as Error).message)).trim();
      const hint =
        key.source === 'file'
          ? ' If the key has a passphrase, load it into your agent first: ssh-add ' + key.privateKeyPath
          : '';
      throw new DevNullError(`Could not sign your commit with ${describeKey(key)}: ${stderr}${hint}`);
    }

    return extractSignature(await readFile(`${payloadPath}.sig`, 'utf8'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function describeKey(key: KeyCandidate): string {
  const type = key.id.split(' ')[0];
  const where = key.source === 'agent' ? 'from the SSH agent' : `from ${key.privateKeyPath}`;
  return `${type}${key.comment ? ` (${key.comment})` : ''} ${where}`;
}
