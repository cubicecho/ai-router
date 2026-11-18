import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** What a failed result that says nothing is reported as. */
const SILENT_FAILURE = 'The tool reported an error and said nothing more.';

/**
 * Whether a tool call that answered is in fact the tool reporting a failure.
 *
 * @param result - What `tools/call` answered.
 * @returns true when the result sets `isError`.
 */
export function isToolError(result: CallToolResult): boolean {
  return result.isError === true;
}

/**
 * Reads what a tool said, as one line of text for an error message.
 *
 * @param result - What `tools/call` answered.
 * @returns The text blocks and embedded text resources joined, else the structured content as JSON, else a fixed
 * message.
 */
export function toolResultText(result: CallToolResult): string {
  const parts = result.content.flatMap((block) => {
    if (block.type === 'text') {
      return [block.text];
    }
    if (block.type === 'resource' && 'text' in block.resource) {
      return [block.resource.text];
    }
    return [];
  });
  const text = parts.join('\n').trim();
  if (text !== '') {
    return text;
  }
  return result.structuredContent === undefined ? SILENT_FAILURE : JSON.stringify(result.structuredContent);
}
