import { describe, expect, it } from 'vitest';
import { isJoinableServerName, splitToolName, toolName } from '../../server/tools/naming.ts';

describe('tool names', () => {
  it('joins a server and its tool with __', () => {
    expect(toolName('files', 'read')).toBe('files__read');
  });

  it('splits at the first __, so a tool name may hold more', () => {
    expect(splitToolName('files__read')).toEqual({ serverName: 'files', tool: 'read' });
    expect(splitToolName(toolName('my_files', 'weird__tool'))).toEqual({ serverName: 'my_files', tool: 'weird__tool' });
  });

  it('splits nothing without a server, a tool or a separator', () => {
    expect(splitToolName('__read')).toBeNull();
    expect(splitToolName('files__')).toBeNull();
    expect(splitToolName('files')).toBeNull();
  });

  it('refuses a server name the split could not give back', () => {
    expect(isJoinableServerName('my_files.v2-beta')).toBe(true);
    expect(isJoinableServerName('a__b')).toBe(false);
    expect(isJoinableServerName('a_')).toBe(false);
    expect(splitToolName(toolName('a_', 'b'))).toEqual({ serverName: 'a', tool: '_b' });
  });
});
