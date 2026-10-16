import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DevNullClient, type FetchLike } from '../src/client.js';
import { DevNullError } from '../src/protocol.js';

interface Call {
  url: string;
  init?: RequestInit;
}

function fakeFetch(responder: (call: Call) => Response): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    return responder(call);
  };
  return { fetch, calls };
}

const text = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('DevNullClient.lookupKey', () => {
  it('posts the candidates as text and returns the matching one', async () => {
    const { fetch, calls } = fakeFetch(() => text('ssh-ed25519 BBB some-comment\n'));
    const client = new DevNullClient({ fetch });
    const key = await client.lookupKey(['ssh-rsa AAA', 'ssh-ed25519 BBB']);
    assert.equal(key, 'ssh-ed25519 BBB');
    assert.equal(calls[0].url, 'https://dev-null.sh/api/cli/key-lookups');
    assert.equal(calls[0].init?.method, 'POST');
    assert.equal(calls[0].init?.body, 'ssh-rsa AAA\nssh-ed25519 BBB\n');
    assert.equal(calls[0].init?.redirect, 'error');
  });
  it('never trusts a key we did not offer', async () => {
    const { fetch } = fakeFetch(() => text('ssh-ed25519 EVIL\n'));
    await assert.rejects(new DevNullClient({ fetch }).lookupKey(['ssh-rsa AAA']), /Unexpected answer/);
  });
  it('surfaces the server error text', async () => {
    const { fetch } = fakeFetch(() => text('None of your SSH keys are on the GitHub account of a /dev/null user.\n', 404));
    await assert.rejects(new DevNullClient({ fetch }).lookupKey(['ssh-rsa AAA']), /None of your SSH keys/);
  });
  it('fails early without candidates', async () => {
    const { fetch, calls } = fakeFetch(() => text(''));
    await assert.rejects(new DevNullClient({ fetch }).lookupKey([]), /No Ed25519 or RSA SSH key/);
    assert.equal(calls.length, 0);
  });
});

describe('DevNullClient.commit', () => {
  it('sends the payload verbatim with the signature header', async () => {
    const { fetch, calls } = fakeFetch(() => text('Committed: https://dev-null.sh/@me/commits/x\n', 201));
    const client = new DevNullClient({ fetch });
    const result = await client.commit('1\nnonce\n\nhello', 'c2ln');
    assert.equal(result, 'Committed: https://dev-null.sh/@me/commits/x');
    assert.equal(calls[0].url, 'https://dev-null.sh/api/cli/commits');
    assert.equal(calls[0].init?.body, '1\nnonce\n\nhello');
    assert.equal((calls[0].init?.headers as Record<string, string>)['X-SSH-Signature'], 'c2ln');
    assert.equal((calls[0].init?.headers as Record<string, string>)['Content-Type'], 'text/plain; charset=utf-8');
  });
  it('turns 401/429 plain-text answers into errors', async () => {
    const { fetch } = fakeFetch(() => text('Slow down: 10 commits a minute. Even CI takes breaks.\n', 429));
    await assert.rejects(new DevNullClient({ fetch }).commit('p', 's'), /Slow down/);
  });
  it('reports network failures', async () => {
    const client = new DevNullClient({
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await assert.rejects(client.commit('p', 's'), /Could not reach https:\/\/dev-null.sh: fetch failed/);
  });
});

describe('DevNullClient read API', () => {
  it('builds the user, commits and single-commit URLs', async () => {
    const { fetch, calls } = fakeFetch(() => json({ data: [] }));
    const client = new DevNullClient({ fetch, baseUrl: 'http://localhost:8000/' });
    await client.user('sfolador');
    await client.userCommits('sfolador', { replies: true, cursor: 'eyJ=' });
    await client.userCommits('sfolador');
    await client.showCommit('01a1461d-a767-73f5-91f5-0a7cdecea096');
    assert.deepEqual(
      calls.map((call) => call.url),
      [
        'http://localhost:8000/api/v1/users/sfolador',
        'http://localhost:8000/api/v1/users/sfolador/commits?replies=1&cursor=eyJ%3D',
        'http://localhost:8000/api/v1/users/sfolador/commits',
        'http://localhost:8000/api/v1/commits/01a1461d-a767-73f5-91f5-0a7cdecea096',
      ],
    );
  });
  it('uses the JSON message of an error response', async () => {
    const { fetch } = fakeFetch(() => json({ message: 'No query results.' }, 404));
    await assert.rejects(new DevNullClient({ fetch }).user('nobody'), /No query results/);
  });
  it('rejects non-JSON success bodies', async () => {
    const { fetch } = fakeFetch(() => text('<html>'));
    await assert.rejects(new DevNullClient({ fetch }).user('x'), /not JSON/);
  });
});

describe('DevNullClient constructor', () => {
  it('refuses insecure base URLs', () => {
    assert.throws(() => new DevNullClient({ baseUrl: 'http://dev-null.sh' }), DevNullError);
  });
});
