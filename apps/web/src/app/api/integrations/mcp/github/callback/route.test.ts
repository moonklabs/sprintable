import { describe, expect, it, vi, beforeEach } from 'vitest';

const {
  createAdminClientMock,
  exchangeGitHubOAuthCodeMock,
} = vi.hoisted(() => ({
  createAdminClientMock: vi.fn(() => ({ tag: 'admin' })),
  exchangeGitHubOAuthCodeMock: vi.fn(),
}));

vi.mock('@/lib/db/admin', () => ({
  createAdminClient: createAdminClientMock,
}));

vi.mock('@/services/project-mcp', () => ({
  exchangeGitHubOAuthCode: exchangeGitHubOAuthCodeMock,
}));

import { encodeMcpOAuthState } from '@/lib/mcp-oauth-state';
import { GET } from './route';

describe('GitHub MCP callback route', () => {
  beforeEach(() => {
    process.env.MCP_CONNECTION_STATE_SECRET = 'test-secret';
    createAdminClientMock.mockClear();
    exchangeGitHubOAuthCodeMock.mockReset();
  });

  it('stores the GitHub OAuth token and redirects back to settings', async () => {
    const state = encodeMcpOAuthState({
      orgId: 'org-1',
      projectId: 'project-1',
      actorId: 'member-1',
      serverKey: 'github',
      issuedAt: Math.floor(Date.now() / 1000),
    });

    const response = await GET(new Request(`https://sprintable.app/api/integrations/mcp/github/callback?code=oauth-code&state=${state}`));

    expect(exchangeGitHubOAuthCodeMock).toHaveBeenCalledWith({ tag: 'admin' }, {
      code: 'oauth-code',
      origin: 'https://sprintable.app',
      orgId: 'org-1',
      projectId: 'project-1',
      actorId: 'member-1',
    });
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://sprintable.app/dashboard/settings?mcp_connection=github_connected');
  });

  it('redirects to an error state when OAuth state verification fails', async () => {
    const response = await GET(new Request('https://sprintable.app/api/integrations/mcp/github/callback?code=oauth-code&state=invalid'));

    expect(exchangeGitHubOAuthCodeMock).not.toHaveBeenCalled();
    expect(response.headers.get('location')).toBe('https://sprintable.app/dashboard/settings?mcp_connection=github_error');
  });
});
