// story #4532 AC5: the channel file route serves html · svg · xml · js (and anything not on the list) as a download, an allowed
// type in place — whatever type the backend reports — and never lets the browser sniff.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { getServerSessionMock, backendFetchMock } = vi.hoisted(() => ({ getServerSessionMock: vi.fn(), backendFetchMock: vi.fn() }));
vi.mock('@/lib/db/server', () => ({ getServerSession: getServerSessionMock }));
vi.mock('@/lib/backend-fetch', () => ({ backendFetch: backendFetchMock }));

import { GET } from './route';

const serve = async (reported: string | null) => {
  backendFetchMock.mockResolvedValueOnce(new Response('<script>alert(1)</script>', { status: 200, headers: reported ? { 'Content-Type': reported } : {} }));
  return GET({} as NextRequest, { params: Promise.resolve({ name: 'f' }) });
};

describe('[SID:4532] /api/channel/files/[name]', () => {
  beforeEach(() => { getServerSessionMock.mockResolvedValue({ access_token: 't' }); backendFetchMock.mockReset(); });

  it.each(['text/html', 'text/html; charset=utf-8', 'image/svg+xml', 'application/xml', 'text/xml', 'application/javascript', 'text/javascript', 'application/xhtml+xml', 'text/plain', null])(
    '%s → a download (octet-stream · attachment · nosniff)', async (reported) => {
      const res = await serve(reported);
      expect(res.headers.get('content-type')).toBe('application/octet-stream');
      expect(res.headers.get('content-disposition')).toBe('attachment');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    });

  it.each(['image/png', 'image/jpeg', 'application/pdf', 'video/mp4', 'audio/mpeg'])('%s → in place (that type · nosniff · no attachment)', async (reported) => {
    const res = await serve(reported);
    expect(res.headers.get('content-type')).toBe(reported);
    expect(res.headers.get('content-disposition')).toBeNull();
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});
