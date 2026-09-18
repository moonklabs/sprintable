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
});
