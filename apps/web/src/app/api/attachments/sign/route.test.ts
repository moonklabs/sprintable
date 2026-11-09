// story 4860 — the signed read address of a stored script-capable document (html · svg · xml) is made as a download; a picture, a PDF, text stay inline.
// The same rule on both authorization paths (room · story path and asset id), for a person's upload and an agent's alike (one signing route).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  signRead: vi.fn(async (_c: string, _p: string, _o?: { disposition?: string }) => 'https://storage.example/signed'),
  headObject: vi.fn(async (_c: string, _p: string) => ({ size: 1, contentType: 'image/png' as string | null })),
  authorize: vi.fn(async (_u: string) => new Response(JSON.stringify({ authorized: true, container: 'bucket-a', object_path: 'org/o/project/p/chat/c/f.bin' }), { status: 200 })),
}));
vi.mock('@/lib/db/server', () => ({ getServerSession: async () => ({ access_token: 'at-1' }) }));
vi.mock('@/lib/storage/factory', () => ({ createStorageService: async () => ({ signRead: h.signRead, headObject: h.headObject }) }));
vi.mock('@/lib/backend-fetch', () => ({ backendFetch: (u: string) => h.authorize(u) }));

import { GET } from './route';
import { resetSignDispositionCache } from '@/lib/storage/sign-disposition';

const OBJ = 'org/o/project/p/chat/c/file.bin';
const roomReq = (extra = '') => new Request(`http://localhost:3000/api/attachments/sign?path=${encodeURIComponent(OBJ)}&conversation_id=c-1${extra}`);
const assetReq = (extra = '') => new Request(`http://localhost:3000/api/attachments/sign?asset_id=a-1${extra}`);
const signedWith = () => (h.signRead.mock.calls[0] as unknown as [string, string, { disposition?: string }])[2].disposition;

beforeEach(() => {
  resetSignDispositionCache();
  h.signRead.mockClear();
  h.authorize.mockClear();
  h.headObject.mockReset();
  h.headObject.mockResolvedValue({ size: 1, contentType: 'image/png' });
});

describe('[SID:4860] /api/attachments/sign — disposition by stored type', () => {
  it.each(['text/html', 'image/svg+xml', 'application/xhtml+xml', 'text/xml'])('room path: a stored %s is signed as attachment', async (t) => {
    h.headObject.mockResolvedValue({ size: 1, contentType: t });
    const res = await GET(roomReq());
    expect(res.status).toBe(200);
    expect(signedWith()).toBe('attachment');
  });

  it('story path: a stored image/svg+xml is signed as attachment too (a story attachment is the same object kind)', async () => {
    h.headObject.mockResolvedValue({ size: 1, contentType: 'image/svg+xml' });
    const res = await GET(new Request(`http://localhost:3000/api/attachments/sign?path=${encodeURIComponent(OBJ)}&story_id=s-1`));
    expect(res.status).toBe(200);
    expect(signedWith()).toBe('attachment');
    expect(h.authorize.mock.calls[0]![0]).toContain('story_id=s-1');
  });

  it.each(['text/html', 'image/svg+xml'])('asset path: a stored %s is signed as attachment, for the container and path the backend named', async (t) => {
    h.headObject.mockResolvedValue({ size: 1, contentType: t });
    const res = await GET(assetReq());
    expect(res.status).toBe(200);
    expect(signedWith()).toBe('attachment');
    expect(h.headObject).toHaveBeenCalledWith('bucket-a', 'org/o/project/p/chat/c/f.bin');
  });

  it.each(['image/png', 'image/jpeg', 'application/pdf', 'text/plain'])('a stored %s keeps inline', async (t) => {
    h.headObject.mockResolvedValue({ size: 1, contentType: t });
    const res = await GET(roomReq());
    expect(res.status).toBe(200);
    expect(signedWith()).toBe('inline');
  });

  // the strings the security review opened in a real Chrome (answered by looking at the content): none of them is on the allow list, so every one is a download
  it.each(['application/unknown', 'unknown/unknown', '*/*', 'text/xsl', 'html', 'text', 'text /html', '', null])(
    'room path: a stored %j is signed as attachment',
    async (t) => {
      h.headObject.mockResolvedValue({ size: 1, contentType: t });
      const res = await GET(roomReq());
      expect(res.status).toBe(200);
      expect(signedWith()).toBe('attachment');
    },
  );

  it.each([
    'application/unknown',
    'unknown/unknown',
    '*/*',
    'text/xsl',
    'html',
    'text',
    'text /html',
    '',
    null,
    'audio/svg+xml',
    `${String.fromCodePoint(0xa0)}image/png${String.fromCodePoint(0xa0)}`,
  ])('asset path: a stored %j is signed as attachment', async (t) => {
    h.headObject.mockResolvedValue({ size: 1, contentType: t });
    const res = await GET(assetReq());
    expect(res.status).toBe(200);
    expect(signedWith()).toBe('attachment');
  });

  it.each(['application/octet-stream', 'application/json', 'text/markdown', 'application/zip'])(
    'a stored %s (not on the allow list) is signed as attachment',
    async (t) => {
      h.headObject.mockResolvedValue({ size: 1, contentType: t });
      await GET(roomReq());
      expect(signedWith()).toBe('attachment');
    },
  );

  it.each(['image/webp', 'image/avif', 'image/bmp', 'audio/mpeg', 'video/mp4'])('a stored %s (on the allow list) keeps inline', async (t) => {
    h.headObject.mockResolvedValue({ size: 1, contentType: t });
    const res = await GET(roomReq());
    expect(res.status).toBe(200);
    expect(signedWith()).toBe('inline');
  });

  it('an explicit ?disposition=attachment is kept for a picture', async () => {
    const res = await GET(roomReq('&disposition=attachment'));
    expect(res.status).toBe(200);
    expect(signedWith()).toBe('attachment');
  });

  it('?disposition=inline cannot turn a stored html back into a page', async () => {
    h.headObject.mockResolvedValue({ size: 1, contentType: 'text/html' });
    const res = await GET(roomReq('&disposition=inline'));
    expect(res.status).toBe(200);
    expect(signedWith()).toBe('attachment');
  });

  it('a stored type that cannot be read → attachment (the answer is still 200 with an address)', async () => {
    h.headObject.mockRejectedValue(new Error('storage.objects.get denied'));
    const res = await GET(roomReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { url: 'https://storage.example/signed' } });
    expect(signedWith()).toBe('attachment');
  });

  it('the authorization is asked first and is not weakened: a refusal signs nothing and asks the storage service nothing', async () => {
    h.authorize.mockResolvedValueOnce(new Response('{}', { status: 403 }));
    const res = await GET(roomReq());
    expect(res.status).toBe(403);
    expect(h.signRead).not.toHaveBeenCalled();
    expect(h.headObject).not.toHaveBeenCalled();
  });
});
