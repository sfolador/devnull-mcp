/**
 * The MCP server: one tool that commits, one that says which key would sign, and three read-only
 * tools over the public API.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { DevNullClient } from './client.js';
import { commitToDevNull, KeyResolver } from './commit.js';
import type { KeyDiscoveryOptions } from './keys.js';
import { commitIdFromReference, DevNullError, MAX_BODY_LENGTH, validateUsername } from './protocol.js';
import { describeKey } from './sign.js';

export interface ServerOptions {
  baseUrl?: string;
  keyOptions?: KeyDiscoveryOptions;
  client?: DevNullClient;
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function text(value: string): ToolResult {
  return { content: [{ type: 'text', text: value }] };
}

function failure(error: unknown): ToolResult {
  const message = error instanceof DevNullError ? error.message : `Unexpected error: ${(error as Error).message ?? String(error)}`;
  return { content: [{ type: 'text', text: message }], isError: true };
}

async function attempt(run: () => Promise<string>): Promise<ToolResult> {
  try {
    return text(await run());
  } catch (error) {
    return failure(error);
  }
}

/** Trims the API's commit objects down to what a reader needs. */
export function summarizeCommits(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') return payload;
  const body = payload as { data?: unknown; meta?: { next_cursor?: unknown; prev_cursor?: unknown } };
  const items = Array.isArray(body.data) ? body.data : body.data ? [body.data] : [];
  const commits = items.map(summarizeCommit);
  const result: Record<string, unknown> = Array.isArray(body.data) ? { commits } : { commit: commits[0] };
  if (body.meta?.next_cursor) result.next_cursor = body.meta.next_cursor;
  return result;
}

function summarizeCommit(item: unknown): unknown {
  if (!item || typeof item !== 'object') return item;
  const commit = item as Record<string, unknown>;
  const author = commit.author as Record<string, unknown> | undefined;
  return {
    id: commit.id,
    short_hash: commit.short_hash,
    author: author?.username,
    body: commit.body,
    created_at: commit.created_at,
    stars: commit.stars_count,
    replies: commit.replies_count,
    parent_id: commit.parent_id ?? undefined,
    url: commit.html_url,
  };
}

export function createServer(options: ServerOptions = {}): McpServer {
  const client = options.client ?? new DevNullClient({ baseUrl: options.baseUrl });
  const resolver = new KeyResolver(client, options.keyOptions);

  const server = new McpServer({ name: 'devnull', version: '0.1.0' });

  server.registerTool(
    'devnull_commit',
    {
      title: 'Commit to /dev/null',
      description:
        'Publish a plain-text post ("commit") on /dev/null (dev-null.sh) as the user, or reply to an existing commit. ' +
        `The message is signed locally with the SSH key that is on the user's GitHub account. Max ${MAX_BODY_LENGTH} characters. ` +
        'Commits are public and the user is rate limited to 10 a minute, so only call this when the user asked to post.',
      inputSchema: {
        message: z.string().min(1).max(MAX_BODY_LENGTH).describe('The commit message to publish, plain text.'),
        reply_to: z
          .string()
          .optional()
          .describe('Optional: the short hash (as shown on /dev/null), UUID or link of the commit to reply to.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ message, reply_to }) => attempt(() => commitToDevNull({ message, replyTo: reply_to }, { client }, resolver)),
  );

  server.registerTool(
    'devnull_whoami',
    {
      title: 'Which key signs',
      description: 'Shows which local SSH key /dev/null recognizes as yours, without posting anything.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      attempt(async () => {
        resolver.forget();
        const key = await resolver.resolve();
        return `Commits will be signed with ${describeKey(key)}.\nPublic key: ${key.id}`;
      }),
  );

  server.registerTool(
    'devnull_get_user',
    {
      title: 'Get a /dev/null user',
      description: 'Public profile of a /dev/null user by GitHub username: bio, links, commit, follower and following counts.',
      inputSchema: { username: z.string().describe('GitHub username, with or without a leading @.') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ username }) => attempt(async () => JSON.stringify(await client.user(validateUsername(username)), null, 2)),
  );

  server.registerTool(
    'devnull_list_commits',
    {
      title: 'List a user’s commits',
      description:
        'The latest approved commits of a /dev/null user (20 per page). Set replies=true for their replies instead of top-level commits; pass next_cursor to page.',
      inputSchema: {
        username: z.string().describe('GitHub username, with or without a leading @.'),
        replies: z.boolean().optional().describe('true to list replies instead of top-level commits.'),
        cursor: z.string().optional().describe('next_cursor from a previous page.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ username, replies, cursor }) =>
      attempt(async () =>
        JSON.stringify(summarizeCommits(await client.userCommits(validateUsername(username), { replies, cursor })), null, 2),
      ),
  );

  server.registerTool(
    'devnull_get_commit',
    {
      title: 'Get a commit',
      description: 'One public /dev/null commit by UUID or link.',
      inputSchema: { commit: z.string().describe('The commit UUID or its /dev/null link.') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ commit }) =>
      attempt(async () => JSON.stringify(summarizeCommits(await client.showCommit(commitIdFromReference(commit))), null, 2)),
  );

  return server;
}
