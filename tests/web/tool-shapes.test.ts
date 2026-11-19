import { describe, expect, it } from 'vitest';
import { describeTransport, HTTP_TRANSPORT_OPTIONS, httpTransportType, transportOf } from '../../web/tools/shapes.ts';

describe('transportOf', () => {
  it('reads both HTTP transports with their URL', () => {
    expect(transportOf({ type: 'streamable-http', url: 'https://a.example/mcp' })).toEqual({
      type: 'streamable-http',
      url: 'https://a.example/mcp',
    });
    expect(transportOf({ type: 'sse', url: 'https://a.example/sse' })).toEqual({
      type: 'sse',
      url: 'https://a.example/sse',
    });
  });

  it('reads anything else it does not know as a program', () => {
    expect(transportOf({ type: 'websocket', url: 'wss://a.example' })).toEqual({
      type: 'stdio',
      command: '',
      args: [],
    });
  });
});

describe('describeTransport', () => {
  it('names each transport, never "Address"', () => {
    expect(describeTransport({ type: 'stdio', command: 'node', args: [] })).toBe('Program');
    expect(describeTransport({ type: 'streamable-http', url: '' })).toBe('Streamable HTTP');
    expect(describeTransport({ type: 'sse', url: '' })).toBe('SSE');
    expect(describeTransport({ type: 'builtin' })).toBe('Inside the router');
  });
});

describe('httpTransportType', () => {
  it('knows the two HTTP transports, newest first, and nothing else', () => {
    expect(HTTP_TRANSPORT_OPTIONS.map((option) => option.value)).toEqual(['streamable-http', 'sse']);
    expect(httpTransportType('sse')).toBe('sse');
    expect(httpTransportType('stdio')).toBeUndefined();
  });
});
