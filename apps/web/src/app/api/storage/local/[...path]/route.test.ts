import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signLocalObject } from '@/lib/storage/local-sign';

// story dc3d62f4(BE·스토리지·self-host, 부수 MEDIUM 처방) — local PUT 수신 핸들러 신설.
// GET은 이미 살아 있었으나(story #2193 계열) 이 파일 자체에 테스트가 없었다 — PUT 신설과
// 함께 GET도 최소 커버.

const SECRET = 'test-secret';
const CONTAINER = 'sprintable-memo-attachments';
const OBJECT_PATH = 'chat/p1/c1/hello.txt';

describe('/api/storage/local/[...path]', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sp-storage-route-'));
    vi.resetModules();
    vi.stubEnv('STORAGE_PROVIDER', 'local');
    vi.stubEnv('STORAGE_LOCAL_ROOT', root);
    vi.stubEnv('STORAGE_LOCAL_SIGNING_SECRET', SECRET);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  function url(path: string, qs: Record<string, string>) {
    const q = new URLSearchParams(qs).toString();
    return `http://localhost/api/storage/local/${path}?${q}`;
  }

  it('PUT: 유효한 write 서명 → 200 + 파일이 실제로 디스크에 쓰인다', async () => {
    const { PUT } = await import('./route');
    const exp = Date.now() + 60_000;
    const sig = signLocalObject(SECRET, CONTAINER, OBJECT_PATH, exp, 'PUT');

    const req = new Request(url(`${CONTAINER}/${OBJECT_PATH}`, { exp: String(exp), sig }), {
      method: 'PUT',
      body: 'hello from PUT',
    });
    const res = await PUT(req as never, { params: Promise.resolve({ path: [CONTAINER, ...OBJECT_PATH.split('/')] }) });
    expect(res.status).toBe(200);

    const written = await readFile(join(root, CONTAINER, OBJECT_PATH), 'utf8');
    expect(written).toBe('hello from PUT');
  });

  it('PUT: read(GET) 서명으로는 거부된다(서명 공간 분리 — read capability로 write 불가)', async () => {
    const { PUT } = await import('./route');
    const exp = Date.now() + 60_000;
    const readSig = signLocalObject(SECRET, CONTAINER, OBJECT_PATH, exp); // method 기본값 GET

    const req = new Request(
      url(`${CONTAINER}/${OBJECT_PATH}`, { exp: String(exp), sig: readSig }),
      { method: 'PUT', body: 'malicious overwrite attempt' },
    );
    const res = await PUT(req as never, { params: Promise.resolve({ path: [CONTAINER, ...OBJECT_PATH.split('/')] }) });
    expect(res.status).toBe(403);

    await expect(readFile(join(root, CONTAINER, OBJECT_PATH), 'utf8')).rejects.toThrow();
  });

  it('PUT: 만료된 서명 → 403', async () => {
    const { PUT } = await import('./route');
    const exp = Date.now() - 1_000;
    const sig = signLocalObject(SECRET, CONTAINER, OBJECT_PATH, exp, 'PUT');

    const req = new Request(url(`${CONTAINER}/${OBJECT_PATH}`, { exp: String(exp), sig }), {
      method: 'PUT',
      body: 'x',
    });
    const res = await PUT(req as never, { params: Promise.resolve({ path: [CONTAINER, ...OBJECT_PATH.split('/')] }) });
    expect(res.status).toBe(403);
  });

  it('PUT: STORAGE_PROVIDER != local → 404(표면 비노출)', async () => {
    vi.stubEnv('STORAGE_PROVIDER', 'gcs');
    vi.resetModules();
    const { PUT } = await import('./route');
    const exp = Date.now() + 60_000;
    const sig = signLocalObject(SECRET, CONTAINER, OBJECT_PATH, exp, 'PUT');

    const req = new Request(url(`${CONTAINER}/${OBJECT_PATH}`, { exp: String(exp), sig }), {
      method: 'PUT',
      body: 'x',
    });
    const res = await PUT(req as never, { params: Promise.resolve({ path: [CONTAINER, ...OBJECT_PATH.split('/')] }) });
    expect(res.status).toBe(404);
  });

  it('GET: write(PUT) 서명으로는 거부된다(역방향도 분리 확認)', async () => {
    const { GET } = await import('./route');
    const exp = Date.now() + 60_000;
    const writeSig = signLocalObject(SECRET, CONTAINER, OBJECT_PATH, exp, 'PUT');

    const req = new Request(url(`${CONTAINER}/${OBJECT_PATH}`, { exp: String(exp), sig: writeSig }));
    const res = await GET(req as never, { params: Promise.resolve({ path: [CONTAINER, ...OBJECT_PATH.split('/')] }) });
    expect(res.status).toBe(403);
  });

  it('GET → PUT → GET 왕복: 쓴 걸 그대로 읽는다', async () => {
    const { GET, PUT } = await import('./route');
    const exp = Date.now() + 60_000;
    const writeSig = signLocalObject(SECRET, CONTAINER, OBJECT_PATH, exp, 'PUT');
    const putReq = new Request(url(`${CONTAINER}/${OBJECT_PATH}`, { exp: String(exp), sig: writeSig }), {
      method: 'PUT',
      body: 'roundtrip content',
    });
    const putRes = await PUT(putReq as never, { params: Promise.resolve({ path: [CONTAINER, ...OBJECT_PATH.split('/')] }) });
    expect(putRes.status).toBe(200);

    const readSig = signLocalObject(SECRET, CONTAINER, OBJECT_PATH, exp);
    const getReq = new Request(url(`${CONTAINER}/${OBJECT_PATH}`, { exp: String(exp), sig: readSig }));
    const getRes = await GET(getReq as never, { params: Promise.resolve({ path: [CONTAINER, ...OBJECT_PATH.split('/')] }) });
    expect(getRes.status).toBe(200);
    const body = Buffer.from(await getRes.arrayBuffer()).toString('utf8');
    expect(body).toBe('roundtrip content');
  });

  // story 4860 — the local provider is the ONE path that serves an uploaded file from OUR OWN origin (self-hosting). An upload's type is whatever the uploader declared (a person or
  // an agent can declare text/html or image/svg+xml with a script inside), so this route must never hand it back as that type: a browser that opens it as text/html would run the
  // script in our origin. It answers every object as application/octet-stream (a browser downloads that instead of drawing it — measured in Chromium 2026-11-08: top-level open of an
  // octet-stream response with `inline` started a download and ran nothing). Nothing held this before: the tests above check the status and the body only.
  async function putThenGet(objectPath: string, content: string, readQuery: Record<string, string> = {}) {
    const { GET, PUT } = await import('./route');
    const exp = Date.now() + 60_000;
    const params = { params: Promise.resolve({ path: [CONTAINER, ...objectPath.split('/')] }) };
    const writeSig = signLocalObject(SECRET, CONTAINER, objectPath, exp, 'PUT');
    const putRes = await PUT(new Request(url(`${CONTAINER}/${objectPath}`, { exp: String(exp), sig: writeSig }), { method: 'PUT', body: content }) as never, params);
    expect(putRes.status).toBe(200);
    const readSig = signLocalObject(SECRET, CONTAINER, objectPath, exp);
    return GET(new Request(url(`${CONTAINER}/${objectPath}`, { exp: String(exp), sig: readSig, ...readQuery })) as never, params);
  }

  it.each([
    ['page.html', '<!doctype html><script>document.title = "ran"</script>'],
    ['pic.svg', '<svg xmlns="http://www.w3.org/2000/svg" onload="document.title = 1"><script>1</script></svg>'],
    ['note.txt', 'plain'],
  ])('GET: %s는 저장된 모양과 상관없이 application/octet-stream으로만 내려간다(우리 출처에서 그려지지 않음)', async (name, content) => {
    const res = await putThenGet(`chat/p1/c1/${name}`, content);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(Buffer.from(await res.arrayBuffer()).toString('utf8')).toBe(content);   // the bytes themselves are untouched
  });

  it.each([
    ['(없음)', {}, 'inline'],
    ['attachment', { disposition: 'attachment' }, 'attachment'],
    ['inline', { disposition: 'inline' }, 'inline'],
    ['그 밖의 값', { disposition: 'whatever' }, 'inline'],
  ])('GET: disposition=%s → content-disposition %s', async (_label, query, want) => {
    const res = await putThenGet('chat/p1/c1/page.html', '<script>1</script>', query as Record<string, string>);
    expect(res.headers.get('content-disposition')).toBe(want);
  });

  it('GET: 응답은 캐시되지 않는다(private, no-store)', async () => {
    const res = await putThenGet('chat/p1/c1/hello.txt', 'x');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });
});
