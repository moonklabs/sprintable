import { describe, expect, it } from 'vitest';
import { spliceApiKey } from './recruiter-client';
import type { McpConfigBundle } from '@/services/recruit';

describe('spliceApiKey (까심 QA RC HIGH① — transport별 키 위치)', () => {
  it('replaces the key in headers.Authorization for the http (hosted) shape', () => {
    const bundle: McpConfigBundle = {
      mcpServers: { sprintable: { type: 'http', url: 'https://mcp.sprintable.ai/mcp', headers: { Authorization: 'Bearer sk_live_old', 'X-Project-Id': 'p1' } } },
    };
    const result = spliceApiKey(bundle, 'sk_live_new');
    expect(result?.mcpServers.sprintable.headers?.Authorization).toBe('Bearer sk_live_new');
    expect(result?.mcpServers.sprintable.headers?.['X-Project-Id']).toBe('p1'); // 다른 필드 보존
  });

  it('replaces the key in env.AGENT_API_KEY for the stdio (local) shape — the bug 까심 caught', () => {
    const bundle: McpConfigBundle = {
      mcpServers: { sprintable: { type: 'stdio', command: 'uvx', args: ['sprintable-mcp'], env: { SPRINTABLE_API_URL: 'https://api.example.com', AGENT_API_KEY: 'sk_live_old' } } },
    };
    const result = spliceApiKey(bundle, 'sk_live_new');
    expect(result?.mcpServers.sprintable.env?.AGENT_API_KEY).toBe('sk_live_new');
    expect(result?.mcpServers.sprintable.env?.SPRINTABLE_API_URL).toBe('https://api.example.com'); // 다른 필드 보존
  });

  it('returns null (never silently stale) when neither key location is present', () => {
    const bundle: McpConfigBundle = { mcpServers: { sprintable: { type: 'stdio', command: 'uvx' } } };
    expect(spliceApiKey(bundle, 'sk_live_new')).toBeNull();
  });
});
