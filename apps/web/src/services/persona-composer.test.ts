import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createAdminClientMock,
  listProjectApprovedMcpToolOptionsMock,
} = vi.hoisted(() => ({
  createAdminClientMock: vi.fn(() => ({ tag: 'admin' })),
  listProjectApprovedMcpToolOptionsMock: vi.fn<(...args: unknown[]) => Promise<Array<{ name: string; serverName: string; groupKind: 'mcp' | 'github' }>>>(async () => []),
}));

vi.mock('@/lib/db/admin', () => ({
  createAdminClient: createAdminClientMock,
}));

vi.mock('./project-mcp', () => ({
  listProjectApprovedMcpToolOptions: listProjectApprovedMcpToolOptionsMock,
}));

import { estimatePromptTokens, listProjectPersonaToolOptions, resolvePersonaToolOptions } from './persona-composer';

describe('persona-composer helpers', () => {
  beforeEach(() => {
    createAdminClientMock.mockClear();
    listProjectApprovedMcpToolOptionsMock.mockReset();
    listProjectApprovedMcpToolOptionsMock.mockResolvedValue([]);
  });

  it('returns built-in tools only from legacy ai-settings config', () => {
    const options = resolvePersonaToolOptions({
      mcp_servers: [{
        name: 'docs',
        url: 'https://mcp.example.com',
        allowed_tools: ['external.search_docs', 'external.fetch_doc'],
        auth: { token_ref: 'MCP_TOKEN_DOCS' },
      }],
      github_mcp: {
        gateway_url: 'https://github-mcp.example.com',
        auth: { token_ref: 'MCP_TOKEN_GITHUB' },
      },
    });

    expect(options.find((option) => option.name === 'get_source_memo')).toMatchObject({
      source: 'builtin',
      groupKind: 'builtin',
      serverName: null,
    });
    expect(options.find((option) => option.name === 'external.search_docs')).toBeUndefined();
    expect(options.find((option) => option.name === 'github.list_issues')).toBeUndefined();
  });

  it('merges approved MCP tool options into the project tool list without reviving legacy MCP config', async () => {
    const db = {
      from(table: string) {
        if (table !== 'project_ai_settings') throw new Error(`Unexpected table: ${table}`);
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: async () => ({
            data: {
              llm_config: {
                mcp_servers: [{
                  name: 'legacy-docs',
                  url: 'https://legacy-docs.example.com',
                  allowed_tools: ['external.search_docs'],
                }],
              },
            },
            error: null,
          }),
        };
      },
    };

    listProjectApprovedMcpToolOptionsMock.mockResolvedValue([
      { name: 'linear.search_issues', serverName: 'Linear', groupKind: 'mcp' },
    ]);

    const options = await listProjectPersonaToolOptions(db as never, 'project-1');

    expect(listProjectApprovedMcpToolOptionsMock).toHaveBeenCalledWith({ tag: 'admin' }, 'project-1');
    expect(options.find((option) => option.name === 'linear.search_issues')).toMatchObject({
      source: 'mcp',
      groupKind: 'mcp',
      serverName: 'Linear',
    });
    expect(options.find((option) => option.name === 'external.search_docs')).toBeUndefined();
  });

  it('returns 0 for blank prompt previews and estimates non-empty prompts by characters', () => {
    expect(estimatePromptTokens('')).toBe(0);
    expect(estimatePromptTokens('abcd')).toBe(1);
    expect(estimatePromptTokens('abcdefgh')).toBe(2);
  });
});
