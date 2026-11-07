// story 4847 — where a chat attachment goes, and what a room with no project says.
//
// The web uploads straight to storage (it does not pass through the server), so the web route is the first place a room with no project meets an attachment: it refuses with the SAME
// coded envelope the server uses (400 `ATTACHMENT_NEEDS_PROJECT`) BEFORE a file is put in storage (an unregistered file would be left behind). Once the server names the room's storage
// prefix (4846 PR2 · AC6: `attachment_path_prefix` on the single-room answer) the same upload is accepted — the refusal tests below are the ones that flip then.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getServerSession, backendFetch, putObject } = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  backendFetch: vi.fn(),
  putObject: vi.fn(),
}));

vi.mock('@/lib/db/server', () => ({ getServerSession }));
vi.mock('@/lib/backend-fetch', () => ({ backendFetch }));
vi.mock('@/lib/storage/factory', () => ({ createStorageService: async () => ({ putObject }) }));
vi.mock('@/lib/fastapi-url', () => ({ fastapiBaseUrl: () => 'http://backend.test' }));

import { POST } from './route';

const ORG = 'org-1';
const CONV = 'conv-1';
const PROJ = 'proj-1';

function request(): Request {
  const form = new FormData();
  form.append('file', new File(['hello'], 'my file.txt', { type: 'text/plain' }));
  return new Request(`http://localhost/api/conversations/${CONV}/attachments`, { method: 'POST', body: form });
}
const call = () => POST(request() as never, { params: Promise.resolve({ conversation_id: CONV }) });
const room = (body: Record<string, unknown>, status = 200) => backendFetch.mockResolvedValue(new Response(JSON.stringify(body), { status }));

beforeEach(() => {
  getServerSession.mockReset().mockResolvedValue({ access_token: 'tok' });
  backendFetch.mockReset();
  putObject.mockReset().mockResolvedValue({ url: 'https://storage.test/obj' });
});

describe('POST /api/conversations/{id}/attachments — a room with a project (as before)', () => {
  it('⭐builds the path from the room\'s organization and project', async () => {
    room({ project_id: PROJ, org_id: ORG });
    const res = await call();
    expect(res.status).toBe(200);
    const path = putObject.mock.calls[0]![1] as string;
    expect(path).toMatch(new RegExp(`^org/${ORG}/project/${PROJ}/chat/${CONV}/[0-9a-f-]{36}-my_file\\.txt$`));
    expect(await res.json()).toMatchObject({ url: 'https://storage.test/obj', name: 'my file.txt', content_type: 'text/plain', size: 5 });
  });

  it('a room that cannot be read stays 403 / 404 (nothing is put in storage)', async () => {
    room({}, 403);
    expect((await call()).status).toBe(403);
    room({}, 500);
    expect((await call()).status).toBe(404);
    expect(putObject).not.toHaveBeenCalled();
  });
});

describe('POST /api/conversations/{id}/attachments — a room with no project (4846 PR1 contract; flips with PR2 AC6)', () => {
  it('⭐is refused with the server\'s own coded envelope — 400 ATTACHMENT_NEEDS_PROJECT — and nothing is put in storage', async () => {
    room({ project_id: null, org_id: ORG });
    const res = await call();
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ data: null, error: { code: 'ATTACHMENT_NEEDS_PROJECT' }, meta: null });
    expect(putObject).not.toHaveBeenCalled();
  });

  it('a room whose project is absent from the answer is the same refusal (not a 422 with no reason)', async () => {
    room({ org_id: ORG });
    expect((await call()).status).toBe(400);
  });

  it('⭐once the server names the room\'s prefix the upload is accepted and goes under it (the PR2 flip)', async () => {
    room({ project_id: null, org_id: ORG, attachment_path_prefix: `org/${ORG}/chat/${CONV}/` });
    const res = await call();
    expect(res.status).toBe(200);
    expect(putObject.mock.calls[0]![1]).toMatch(new RegExp(`^org/${ORG}/chat/${CONV}/[0-9a-f-]{36}-my_file\\.txt$`));
  });

  it('a prefix with a project in it is taken too (the server builds both shapes)', async () => {
    room({ project_id: PROJ, org_id: ORG, attachment_path_prefix: `org/${ORG}/project/${PROJ}/chat/${CONV}/` });
    expect((await call()).status).toBe(200);
    expect(putObject.mock.calls[0]![1]).toMatch(new RegExp(`^org/${ORG}/project/${PROJ}/chat/${CONV}/`));
  });
});

describe('POST /api/conversations/{id}/attachments — a prefix is taken only when it is this organization\'s and this room\'s', () => {
  const bad = (name: string, prefix: string) =>
    it(`⭐${name} → ignored (a room with no project is then refused, a room with one keeps its own path)`, async () => {
      room({ project_id: null, org_id: ORG, attachment_path_prefix: prefix });
      expect((await call()).status).toBe(400);
      room({ project_id: PROJ, org_id: ORG, attachment_path_prefix: prefix });
      expect((await call()).status).toBe(200);
      expect(putObject.mock.calls.at(-1)![1]).toMatch(new RegExp(`^org/${ORG}/project/${PROJ}/chat/${CONV}/`));
    });

  bad('another room\'s id', `org/${ORG}/chat/conv-2/`);
  bad('another organization', `org/other-org/chat/${CONV}/`);
  bad('a dot segment', `org/${ORG}/chat/../chat/${CONV}/`);
  bad('no trailing slash', `org/${ORG}/chat/${CONV}`);
  bad('a different shape', `org/${ORG}/docs/${CONV}/`);
  bad('a double slash', `org/${ORG}//chat/${CONV}/`);
  bad('a backslash', `org/${ORG}/chat\\${CONV}/`);
  bad('not a string', 42 as unknown as string);
});
