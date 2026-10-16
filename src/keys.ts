/**
 * Finds the local public keys that could be on the user's GitHub account: the ones the SSH agent
 * holds, and the ~/.ssh/*.pub files whose private key is next to them. Private keys are never read.
 */
import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { DevNullError, keyId, uniqueKeyIds } from './protocol.js';

const execFileAsync = promisify(execFile);

export interface KeyCandidate {
  /** "<type> <base64>" */
  id: string;
  /** Where the key can sign from: the agent, or a private key file. */
  source: 'agent' | 'file';
  /** Set when source is 'file'. */
  privateKeyPath?: string;
  /** The trailing comment of the public key line, when any. */
  comment?: string;
}

export interface KeyDiscoveryOptions {
  sshDir?: string;
  /** Explicit private key path (DEVNULL_SSH_KEY); its public key is derived with ssh-keygen -y. */
  explicitKeyPath?: string;
  runAgent?: () => Promise<string>;
}

export async function agentKeyLines(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('ssh-add', ['-L'], { timeout: 5000 });
    return stdout;
  } catch {
    return '';
  }
}

export async function agentKeys(run: () => Promise<string> = agentKeyLines): Promise<KeyCandidate[]> {
  const lines = (await run()).split('\n');
  return uniqueKeyIds(lines).map((id) => ({ id, source: 'agent', comment: commentOf(lines, id) }));
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function fileKeys(sshDir: string = join(homedir(), '.ssh')): Promise<KeyCandidate[]> {
  let entries: string[];
  try {
    entries = await readdir(sshDir);
  } catch {
    return [];
  }
  const found: KeyCandidate[] = [];
  for (const entry of entries.filter((name) => name.endsWith('.pub')).sort()) {
    const publicPath = join(sshDir, entry);
    const privateKeyPath = publicPath.slice(0, -'.pub'.length);
    if (!(await isFile(publicPath)) || !(await isFile(privateKeyPath))) continue;
    const firstLine = (await readFile(publicPath, 'utf8')).split('\n')[0] ?? '';
    const id = keyId(firstLine);
    if (id) found.push({ id, source: 'file', privateKeyPath, comment: commentOf([firstLine], id) });
  }
  return found;
}

export async function explicitKey(privateKeyPath: string): Promise<KeyCandidate> {
  if (!(await isFile(privateKeyPath))) {
    throw new DevNullError(`DEVNULL_SSH_KEY points to ${privateKeyPath}, which is not a file.`);
  }
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('ssh-keygen', ['-y', '-f', privateKeyPath], {
      timeout: 10_000,
      env: { ...process.env, SSH_ASKPASS_REQUIRE: 'never' },
      encoding: 'utf8',
    }));
  } catch (error) {
    throw new DevNullError(
      `Could not derive the public key of ${privateKeyPath} (is it passphrase-protected? then load it with ssh-add): ${(error as Error).message}`,
    );
  }
  const id = keyId(stdout);
  if (!id) throw new DevNullError(`${privateKeyPath} is not an Ed25519 or RSA key.`);
  return { id, source: 'file', privateKeyPath, comment: commentOf([stdout], id) };
}

/**
 * Agent keys come first: signing through the agent never touches a key file and works with
 * hardware keys. Duplicates (same key in the agent and on disk) keep the agent entry.
 */
export async function discoverKeys(options: KeyDiscoveryOptions = {}): Promise<KeyCandidate[]> {
  const candidates: KeyCandidate[] = [];
  if (options.explicitKeyPath) candidates.push(await explicitKey(options.explicitKeyPath));
  candidates.push(...(await agentKeys(options.runAgent)));
  candidates.push(...(await fileKeys(options.sshDir)));

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.id)) return false;
    seen.add(candidate.id);
    return true;
  });
}

function commentOf(lines: string[], id: string): string | undefined {
  for (const line of lines) {
    if (keyId(line) !== id) continue;
    const comment = line.trim().split(/\s+/).slice(2).join(' ');
    return comment === '' ? undefined : comment;
  }
  return undefined;
}
