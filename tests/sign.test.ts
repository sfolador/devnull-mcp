import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';

import { discoverKeys } from '../src/keys.js';
import { NAMESPACE } from '../src/protocol.js';
import { signPayload } from '../src/sign.js';

const run = promisify(execFile);
let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'devnull-sign-'));
  await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'test-key', '-f', join(dir, 'id_ed25519')]);
});

after(() => rm(dir, { recursive: true, force: true }));

describe('signPayload', () => {
  it('produces a signature ssh-keygen verifies in the devnull-commit namespace', async () => {
    const [key] = await discoverKeys({ sshDir: dir, runAgent: async () => '' });
    assert.equal(key.source, 'file');

    const payload = '1700000000\n' + 'ab'.repeat(16) + '\n\nHello from the test suite';
    const signature = await signPayload(payload, key);
    assert.match(signature, /^[A-Za-z0-9+/=]+$/);

    const publicKey = (await readFile(join(dir, 'id_ed25519.pub'), 'utf8')).trim();
    const allowedSigners = join(dir, 'allowed_signers');
    await writeFile(allowedSigners, `tester ${publicKey}\n`);
    const sigPath = join(dir, 'payload.sig');
    await writeFile(sigPath, `-----BEGIN SSH SIGNATURE-----\n${signature.match(/.{1,70}/g)!.join('\n')}\n-----END SSH SIGNATURE-----\n`);
    const payloadPath = join(dir, 'payload');
    await writeFile(payloadPath, payload);

    const { stdout } = await run('sh', [
      '-c',
      `ssh-keygen -Y verify -f "${allowedSigners}" -I tester -n ${NAMESPACE} -s "${sigPath}" < "${payloadPath}"`,
    ]);
    assert.match(stdout, /Good "devnull-commit" signature/);
  });

  it('fails with a clear error when the private key is unusable', async () => {
    await assert.rejects(
      signPayload('x', { id: 'ssh-ed25519 AAAA', source: 'file', privateKeyPath: join(dir, 'missing') }),
      /Could not sign your commit/,
    );
  });
});
