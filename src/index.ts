#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createServer } from './server.js';

async function main(): Promise<void> {
  const server = createServer({
    baseUrl: process.env.DEVNULL_URL,
    keyOptions: { explicitKeyPath: process.env.DEVNULL_SSH_KEY || undefined },
  });
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  process.stderr.write(`devnull-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
