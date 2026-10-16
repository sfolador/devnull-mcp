import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { DevNullClient } from '../src/client.js';
import { createServer, summarizeCommits } from '../src/server.js';

const sampleCommit = {
  id: '01a1461d-a767-73f5-91f5-0a7cdecea096',
  short_hash: 'ecea096',
  body: 'Hello',
  parent_id: null,
  html_url: 'https://dev-null.sh/@sfolador/commits/01a1461d-a767-73f5-91f5-0a7cdecea096',
  created_at: '2026-10-16T19:08:30Z',
  stars_count: 2,
  replies_count: 1,
  link_preview: { url: 'x' },
  images: [],
  author: { username: 'sfolador', avatar_url: 'big' },
};

describe('summarizeCommits', () => {
  it('keeps the useful fields of a list and the next cursor', () => {
    const result = summarizeCommits({ data: [sampleCommit], meta: { next_cursor: 'abc', prev_cursor: null } }) as {
      commits: unknown[];
      next_cursor: string;
    };
    assert.equal(result.next_cursor, 'abc');
    assert.deepEqual(result.commits[0], {
      id: sampleCommit.id,
      short_hash: 'ecea096',
      author: 'sfolador',
      body: 'Hello',
      created_at: '2026-10-16T19:08:30Z',
      stars: 2,
      replies: 1,
      parent_id: undefined,
      url: sampleCommit.html_url,
    });
  });
  it('wraps a single commit', () => {
    const result = summarizeCommits({ data: sampleCommit }) as { commit: { short_hash: string } };
    assert.equal(result.commit.short_hash, 'ecea096');
  });
});

async function connectedClient(devnull: DevNullClient): Promise<Client> {
  const server = createServer({ client: devnull, keyOptions: { sshDir: '/nonexistent', runAgent: async () => '' } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

describe('MCP server', () => {
  it('exposes the five tools', async () => {
    const client = await connectedClient(new DevNullClient({ fetch: async () => new Response('{}') }));
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ['devnull_commit', 'devnull_get_commit', 'devnull_get_user', 'devnull_list_commits', 'devnull_whoami'],
    );
    const commit = tools.find((tool) => tool.name === 'devnull_commit')!;
    assert.equal(commit.annotations?.readOnlyHint, false);
    assert.equal(tools.find((tool) => tool.name === 'devnull_get_user')!.annotations?.readOnlyHint, true);
  });

  it('returns read-API data compactly', async () => {
    const client = await connectedClient(
      new DevNullClient({
        fetch: async (url) =>
          new Response(JSON.stringify(url.includes('/commits') ? { data: [sampleCommit], meta: {} } : { data: { username: 'sfolador' } })),
      }),
    );
    const result = await client.callTool({ name: 'devnull_list_commits', arguments: { username: '@sfolador' } });
    const text = (result.content as Array<{ text: string }>)[0].text;
    assert.match(text, /"short_hash": "ecea096"/);
    assert.doesNotMatch(text, /avatar_url/);
  });

  it('reports failures as tool errors instead of throwing', async () => {
    const client = await connectedClient(new DevNullClient({ fetch: async () => new Response('nope', { status: 500 }) }));
    const result = await client.callTool({ name: 'devnull_commit', arguments: { message: 'Hello there' } });
    assert.equal(result.isError, true);
    assert.match((result.content as Array<{ text: string }>)[0].text, /No Ed25519 or RSA SSH key/);
  });
});
