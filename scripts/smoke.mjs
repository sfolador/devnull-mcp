import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({ command: 'node', args: [new URL('../dist/index.js', import.meta.url).pathname] });
const client = new Client({ name: 'smoke', version: '0.0.0' });
await client.connect(transport);

const { tools } = await client.listTools();
console.log('tools:', tools.map((t) => t.name).join(', '));

for (const call of [
  { name: 'devnull_whoami', arguments: {} },
  { name: 'devnull_get_user', arguments: { username: 'sfolador' } },
  { name: 'devnull_list_commits', arguments: { username: 'sfolador' } },
  { name: 'devnull_get_commit', arguments: { commit: 'https://dev-null.sh/@sfolador/commits/01a1461d-a767-73f5-91f5-0a7cdecea096' } },
  { name: 'devnull_commit', arguments: { message: 'hi' } },
]) {
  const result = await client.callTool(call);
  console.log(`\n== ${call.name} (isError=${result.isError ?? false}) ==`);
  console.log(result.content[0].text.slice(0, 700));
}
await client.close();
