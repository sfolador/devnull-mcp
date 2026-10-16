import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { agentKeys, discoverKeys, fileKeys } from '../src/keys.js';

let sshDir: string;

before(async () => {
  sshDir = await mkdtemp(join(tmpdir(), 'devnull-keys-'));
  await writeFile(join(sshDir, 'id_ed25519'), 'PRIVATE');
  await writeFile(join(sshDir, 'id_ed25519.pub'), 'ssh-ed25519 AAAAED me@host\n');
  await writeFile(join(sshDir, 'orphan.pub'), 'ssh-ed25519 AAAAORPHAN\n'); // no private key next to it
  await writeFile(join(sshDir, 'id_ecdsa'), 'PRIVATE');
  await writeFile(join(sshDir, 'id_ecdsa.pub'), 'ecdsa-sha2-nistp256 AAAAEC\n');
  await writeFile(join(sshDir, 'work'), 'PRIVATE');
  await writeFile(join(sshDir, 'work.pub'), 'ssh-rsa AAAARSA work\n');
});

after(() => rm(sshDir, { recursive: true, force: true }));

describe('fileKeys', () => {
  it('lists Ed25519/RSA .pub files that have a private key next to them', async () => {
    const keys = await fileKeys(sshDir);
    assert.deepEqual(
      keys.map((key) => [key.id, key.source, key.privateKeyPath, key.comment]),
      [
        ['ssh-ed25519 AAAAED', 'file', join(sshDir, 'id_ed25519'), 'me@host'],
        ['ssh-rsa AAAARSA', 'file', join(sshDir, 'work'), 'work'],
      ],
    );
  });
  it('returns nothing for a missing directory', async () => {
    assert.deepEqual(await fileKeys(join(sshDir, 'missing')), []);
  });
});

describe('agentKeys', () => {
  it('parses ssh-add -L output', async () => {
    const keys = await agentKeys(async () => 'ssh-ed25519 AAAAAG agent-key\nssh-rsa AAAARSA\n');
    assert.deepEqual(
      keys.map((key) => [key.id, key.source, key.comment]),
      [
        ['ssh-ed25519 AAAAAG', 'agent', 'agent-key'],
        ['ssh-rsa AAAARSA', 'agent', undefined],
      ],
    );
  });
  it('treats "The agent has no identities." as no keys', async () => {
    assert.deepEqual(await agentKeys(async () => 'The agent has no identities.\n'), []);
  });
});

describe('discoverKeys', () => {
  it('puts agent keys first and keeps the agent entry for duplicates', async () => {
    const keys = await discoverKeys({ sshDir, runAgent: async () => 'ssh-rsa AAAARSA\n' });
    assert.deepEqual(
      keys.map((key) => [key.id, key.source]),
      [
        ['ssh-rsa AAAARSA', 'agent'],
        ['ssh-ed25519 AAAAED', 'file'],
      ],
    );
  });
});
