import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { DevNullClient } from '../src/client.js';
import { commitToDevNull, KeyResolver } from '../src/commit.js';
import type { KeyCandidate } from '../src/keys.js';

let sshDir: string;
before(async () => {
  sshDir = await mkdtemp(join(tmpdir(), 'devnull-commit-'));
  await writeFile(join(sshDir, 'id_ed25519'), 'PRIVATE');
  await writeFile(join(sshDir, 'id_ed25519.pub'), 'ssh-ed25519 AAAAED me@host\n');
});
after(() => rm(sshDir, { recursive: true, force: true }));

function clientAnswering(lookup: string, commitReply: string, status = 201) {
  const posts: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  const client = new DevNullClient({
    fetch: async (url, init) => {
      posts.push({ url, body: String(init?.body), headers: init?.headers as Record<string, string> });
      if (url.endsWith('/key-lookups')) return new Response(lookup);
      return new Response(commitReply, { status });
    },
  });
  return { client, posts };
}

describe('commitToDevNull', () => {
  it('looks the key up, signs the exact payload and posts it', async () => {
    const { client, posts } = clientAnswering('ssh-ed25519 AAAAED\n', 'Committed: https://dev-null.sh/@me/commits/1\n');
    const signed: Array<{ payload: string; key: KeyCandidate }> = [];
    const result = await commitToDevNull(
      { message: 'Hello world!', replyTo: '0be0130' },
      {
        client,
        keyOptions: { sshDir, runAgent: async () => '' },
        sign: async (payload, key) => {
          signed.push({ payload, key });
          return 'U0lH';
        },
        now: () => 1700000000,
        nonce: () => 'f'.repeat(32),
      },
    );
    assert.equal(result, 'Committed: https://dev-null.sh/@me/commits/1');
    assert.equal(signed[0].payload, `1700000000\n${'f'.repeat(32)}\n0be0130\nHello world!`);
    assert.equal(signed[0].key.privateKeyPath, join(sshDir, 'id_ed25519'));
    assert.equal(posts[1].body, signed[0].payload);
    assert.equal(posts[1].headers['X-SSH-Signature'], 'U0lH');
  });

  it('validates before touching the network', async () => {
    const { client, posts } = clientAnswering('', '');
    await assert.rejects(commitToDevNull({ message: 'hi' }, { client }), /at least 3/);
    await assert.rejects(commitToDevNull({ message: 'hello', replyTo: 'a b' }, { client }), /reply_to/);
    assert.equal(posts.length, 0);
  });

  it('reuses the resolved key across commits and forgets it when the server stops recognizing it', async () => {
    let commitStatus = 201;
    let commitReply = 'Committed: ok\n';
    const posts: string[] = [];
    const client = new DevNullClient({
      fetch: async (url) => {
        posts.push(url);
        if (url.endsWith('/key-lookups')) return new Response('ssh-ed25519 AAAAED\n');
        return new Response(commitReply, { status: commitStatus });
      },
    });
    const resolver = new KeyResolver(client, { sshDir, runAgent: async () => '' });
    const deps = { client, sign: async () => 'U0lH' };

    await commitToDevNull({ message: 'first' }, deps, resolver);
    await commitToDevNull({ message: 'second' }, deps, resolver);
    assert.equal(posts.filter((url) => url.endsWith('/key-lookups')).length, 1);

    commitStatus = 401;
    commitReply = 'This SSH key (SHA256:x) is not on the GitHub account of a /dev/null user.\n';
    await assert.rejects(commitToDevNull({ message: 'third' }, deps, resolver), /not on the GitHub account/);
    commitStatus = 201;
    commitReply = 'Committed: ok\n';
    await commitToDevNull({ message: 'fourth' }, deps, resolver);
    assert.equal(posts.filter((url) => url.endsWith('/key-lookups')).length, 2);
  });
});
