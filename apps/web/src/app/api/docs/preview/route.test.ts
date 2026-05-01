import { beforeEach, describe, expect, it, vi } from 'vitest';
import { extractEmbedIds } from './extract-embed-ids';

// ---------------------------------------------------------------------------
// Pure helper — extractEmbedIds
// ---------------------------------------------------------------------------

describe('extractEmbedIds', () => {
  it('returns empty array for null input', () => {
    expect(extractEmbedIds(null)).toEqual([]);
  });

  it('returns empty array for undefined input', () => {
    expect(extractEmbedIds(undefined)).toEqual([]);
  });

  it('returns empty array when no embed nodes in HTML', () => {
    expect(extractEmbedIds('<p>Hello world</p>')).toEqual([]);
  });

  it('extracts a single doc ID from a page-embed div', () => {
    const html = '<div data-page-embed data-doc-id="abc-123" data-title="My Doc" data-slug="my-doc"></div>';
    expect(extractEmbedIds(html)).toEqual(['abc-123']);
  });

  it('extracts multiple doc IDs from multiple embed nodes', () => {
    const html = [
      '<div data-page-embed data-doc-id="id-1" data-slug="doc-1"></div>',
      '<p>Some text</p>',
      '<div data-page-embed data-doc-id="id-2" data-slug="doc-2"></div>',
    ].join('\n');
    expect(extractEmbedIds(html)).toEqual(['id-1', 'id-2']);
  });

  it('ignores elements without data-doc-id', () => {
    const html = '<div data-page-embed data-slug="no-id"></div>';
    expect(extractEmbedIds(html)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Route handler — GET /api/docs/preview
// ---------------------------------------------------------------------------

const { createDbServerClient, createAdminClient, getAuthContext } = vi.hoisted(() => ({
  createDbServerClient: vi.fn(),
  createAdminClient: vi.fn(),
  getAuthContext: vi.fn(),
}));

const getDocPreviewMock = vi.fn();

vi.mock('@/lib/db/server', () => ({ createDbServerClient }));
vi.mock('@/lib/db/admin', () => ({ createAdminClient }));
vi.mock('@/lib/auth-helpers', () => ({ getAuthContext }));
vi.mock('@/services/docs', () => ({
  DocsService: class {
    getDocPreview = getDocPreviewMock;
  },
}));

// DB client stub for collectTransitiveEmbeds BFS (no embeds in target docs)
const fromMock = vi.fn().mockReturnValue({
  select: vi.fn().mockReturnThis(),
  eq: vi.fn().mockReturnThis(),
  in: vi.fn().mockResolvedValue({ data: [] }),
});
const mockDbClient = { from: fromMock };

import { GET } from './route';

const mockAuth = {
  id: 'team-member-1',
  org_id: 'org-1',
  project_id: 'project-1',
  project_name: 'Test',
  type: 'human' as const,
  rateLimitExceeded: false,
};

describe('GET /api/docs/preview', () => {
  beforeEach(() => {
    createDbServerClient.mockReset();
    createAdminClient.mockReset();
    getAuthContext.mockReset();
    getDocPreviewMock.mockReset();
    fromMock.mockClear();

    createDbServerClient.mockResolvedValue(mockDbClient);
    createAdminClient.mockReturnValue(mockDbClient);
    getAuthContext.mockResolvedValue(mockAuth);
  });

  it('returns 401 when not authenticated', async () => {
    getAuthContext.mockResolvedValue(null);
    const res = await GET(new Request('http://localhost/api/docs/preview?q=my-doc'));
    expect(res.status).toBe(401);
  });

  it('returns 429 when rate limit exceeded', async () => {
    getAuthContext.mockResolvedValue({
      ...mockAuth,
      rateLimitExceeded: true,
      rateLimitRemaining: 0,
      rateLimitResetAt: 9999,
    });
    const res = await GET(new Request('http://localhost/api/docs/preview?q=my-doc'));
    expect(res.status).toBe(429);
  });

  it('returns 400 when q param is missing', async () => {
    const res = await GET(new Request('http://localhost/api/docs/preview'));
    expect(res.status).toBe(400);
  });

  it('returns 404 when document is not found', async () => {
    getDocPreviewMock.mockResolvedValue(null);
    const res = await GET(new Request('http://localhost/api/docs/preview?q=nonexistent'));
    expect(res.status).toBe(404);
  });

  it('returns preview fields with empty embedChain when doc has no embeds', async () => {
    getDocPreviewMock.mockResolvedValue({
      id: 'doc-abc',
      title: 'My Doc',
      icon: '📄',
      slug: 'my-doc',
      content: '<p>No embeds here</p>',
    });

    const res = await GET(new Request('http://localhost/api/docs/preview?q=my-doc'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({
      id: 'doc-abc',
      title: 'My Doc',
      icon: '📄',
      slug: 'my-doc',
      embedChain: [],
    });
  });

  it('accepts UUID as q param and passes it to service', async () => {
    const uuid = '12345678-1234-1234-1234-123456789abc';
    getDocPreviewMock.mockResolvedValue({
      id: uuid,
      title: 'UUID Doc',
      icon: null,
      slug: 'uuid-doc',
      content: null,
    });

    const res = await GET(new Request(`http://localhost/api/docs/preview?q=${uuid}`));
    expect(res.status).toBe(200);
    expect(getDocPreviewMock).toHaveBeenCalledWith('project-1', uuid);
  });

  it('accepts slug as q param and passes it to service', async () => {
    getDocPreviewMock.mockResolvedValue({
      id: 'doc-xyz',
      title: 'Slug Doc',
      icon: null,
      slug: 'my-slug',
      content: null,
    });

    const res = await GET(new Request('http://localhost/api/docs/preview?q=my-slug'));
    expect(res.status).toBe(200);
    expect(getDocPreviewMock).toHaveBeenCalledWith('project-1', 'my-slug');
  });
});
