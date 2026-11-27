// story 5047 (C14 · PO 11-27): the quick-ask window shows ONE page of the web (/quick) and may show no other, so that page — and only that page — is reachable without a session: a redirect to /login would put a
// page in the small window that it is not allowed to show. Removing '/quick' from PUBLIC_EXACT turns the first case red; making it a prefix turns the second red.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
import { proxy as middleware } from './proxy';

const req = (path: string) => new NextRequest(`https://app.example.com${path}`);

describe('[SID:5047] /quick is public — exactly', () => {
  beforeEach(() => { process.env['JWT_SECRET'] = 'test-secret-for-proxy-tests'; process.env['NEXT_PUBLIC_FASTAPI_URL'] = 'http://localhost:8000'; });
  afterEach(() => { delete process.env['JWT_SECRET']; });

  it('without a session /quick is served, not sent to sign in', async () => {
    const response = await middleware(req('/quick'));
    expect(response.status).not.toBe(307);
  });

  it('what is under it, and a neighbour that shares its letters, stay behind the session (an organization may be named «quick»)', async () => {
    for (const path of ['/quick/proj/board', '/quickly', '/quick-2/proj/board']) {
      const response = await middleware(req(path));
      expect(response.status, path).toBe(307);
      expect(response.headers.get('location') ?? '', path).toContain('/login');
    }
  });
});
