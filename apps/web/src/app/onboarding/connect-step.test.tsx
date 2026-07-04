import { describe, expect, it } from 'vitest';
import { inferTransport } from './connect-step';
import { RAIL_ORDER, HTTP_RAIL_ORDER } from './verify-rail';

describe('inferTransport (E-MCP-OPT S3 — transport 미지정 default-resolve 응답 판별)', () => {
  it('reads type:"http" from a hosted artifact', () => {
    const content = JSON.stringify({
      mcpServers: { sprintable: { type: 'http', url: 'https://mcp.sprintable.ai/mcp', headers: {} } },
    });
    expect(inferTransport(content)).toBe('http');
  });

  it('reads type:"stdio" from a local artifact', () => {
    const content = JSON.stringify({
      mcpServers: { sprintable: { type: 'stdio', command: 'uvx', args: ['sprintable-mcp'] } },
    });
    expect(inferTransport(content)).toBe('stdio');
  });

  it('falls back to stdio on malformed content (never throws, never defaults to hosted)', () => {
    expect(inferTransport('not json')).toBe('stdio');
    expect(inferTransport('{}')).toBe('stdio');
  });
});

describe('rail orders (E-MCP-OPT S3 — transport-aware verify rail shape)', () => {
  it('stdio rail keeps the full 6-stage canonical order (regression guard)', () => {
    expect(RAIL_ORDER).toEqual([
      'config_copied', 'waiting', 'mcp_reachable', 'event_delivered', 'ack', 'verified',
    ]);
  });

  it('http rail is a 4-stage reduction with no event_delivered/ack (structurally impossible over http)', () => {
    expect(HTTP_RAIL_ORDER).toEqual(['config_copied', 'waiting', 'mcp_reachable', 'verified']);
    expect(HTTP_RAIL_ORDER).not.toContain('event_delivered');
    expect(HTTP_RAIL_ORDER).not.toContain('ack');
  });
});
