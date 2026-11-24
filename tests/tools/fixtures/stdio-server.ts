/**
 * A small stdio MCP server, spawned as a real child by the instance tests.
 *
 * Run by `process.execPath`, which strips the types. It reports its pid, env and folder, so a test can tell one
 * child from the next and see what it was started with. `--die-at-start` makes it write to stderr and exit before
 * the handshake, and `--linger` keeps it running after its stdin closes, so only a signal stops it.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

/** What `crash` writes to stderr on its way out. */
const CRASH_LINE = 'fixture crashed on purpose';

if (process.argv.includes('--die-at-start')) {
  process.stderr.write('fixture refused to start\n');
  process.exit(3);
}

/** How often the lingering fixture wakes, for nothing: the timer only keeps it alive. */
const LINGER_TICK_MS = 60_000;

if (process.argv.includes('--linger')) {
  setInterval(() => undefined, LINGER_TICK_MS);
}

const server = new McpServer({ name: 'fixture', version: '1.0.0' });

/**
 * Answers with one text block.
 *
 * @param text - The text.
 * @returns The tool result.
 */
const text = (text: string) => ({ content: [{ type: 'text' as const, text }] });

server.registerTool('echo', { description: 'Answers with its text.', inputSchema: { text: z.string() } }, (args) =>
  text(args.text),
);
server.registerTool('pid', { description: 'Reports its process id.' }, () => text(String(process.pid)));
server.registerTool('env', { description: 'Reports its environment.' }, () => text(JSON.stringify(process.env)));
server.registerTool('cwd', { description: 'Reports its folder.' }, () => text(process.cwd()));
server.registerTool('sleep', { description: 'Waits, then answers.', inputSchema: { ms: z.number() } }, async (args) => {
  await new Promise((resolve) => setTimeout(resolve, args.ms));
  return text('slept');
});
server.registerTool('fail', { description: 'Reports a failure.' }, () => ({
  content: [{ type: 'text' as const, text: 'it went wrong' }],
  isError: true,
}));
server.registerTool('crash', { description: 'Exits without answering.' }, () => {
  process.stderr.write(`${CRASH_LINE}\n`, () => process.exit(1));
  return new Promise<never>(() => undefined);
});
server.registerTool(
  'ask',
  { description: 'Asks its caller for a code, and says what it got.', inputSchema: { quiet: z.boolean().optional() } },
  async (args) => {
    const answer = await server.server.elicitInput({
      message: 'What is the code?',
      requestedSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
    });
    if (args.quiet === true) {
      return text(answer.action);
    }
    return text(answer.action === 'accept' ? `got ${String(answer.content?.code)}` : answer.action);
  },
);
server.registerTool('grow', { description: 'Adds the `extra` tool.' }, () => {
  server.registerTool('extra', { description: 'Added by `grow`.' }, () => text('extra'));
  return text('grown');
});

await server.connect(new StdioServerTransport());
