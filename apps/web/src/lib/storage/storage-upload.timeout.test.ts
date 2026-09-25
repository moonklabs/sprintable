// @vitest-environment jsdom
// story #4310 AC4 — fetchWithAuth에 기본 시간 제한(응답 헤더까지 30s)이 생겨도 긴 업로드는 안 끊긴다: 파일 바이트는 서명 URL로
// XMLHttpRequest PUT(GCS 직행 · fetchWithAuth 밖)이라 제한이 닿지 않고, fetchWithAuth는 짧은 upload-url · confirm만 탄다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uploadStorageAsset } from './storage-upload';

class SlowXhr {
  static last: SlowXhr | null = null;
  static finishAfterMs = 90_000;
  upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  status = 0;
  method = '';
  url = '';
  open(method: string, url: string) { this.method = method; this.url = url; }
  setRequestHeader() {}
  send() {
    SlowXhr.last = this;
    setTimeout(() => { this.status = 200; this.onload?.(); }, SlowXhr.finishAfterMs);
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.stubGlobal('XMLHttpRequest', SlowXhr);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/assets/upload-url') {
      return new Response(JSON.stringify({ data: { upload_url: 'https://storage.example/put', object_path: 'p/a.bin', expires_at: '', required_put_headers: {} } }), { status: 200 });
    }
    if (url === '/api/assets/upload-confirm') return new Response(JSON.stringify({ data: { id: 'asset-1' } }), { status: 200 });
    throw new Error(`unexpected fetch ${url}`);
  }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); SlowXhr.last = null; });

describe('uploadStorageAsset — 긴 업로드는 fetchWithAuth 시간 제한에 안 끊김(story #4310 AC4)', () => {
  it('⭐파일 PUT이 90s 걸려도(기본 제한 30s의 3배) 끝까지 가서 자산을 돌려준다', async () => {
    const file = new File(['x'.repeat(10)], 'a.bin', { type: 'application/octet-stream' });
    const settled = uploadStorageAsset({ file, projectId: 'p1', folderId: null }).then((a) => a, (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(SlowXhr.last?.method, '바이트는 XHR PUT으로 스토리지 직행').toBe('PUT');
    expect(SlowXhr.last?.url).toBe('https://storage.example/put');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await settled).toEqual({ id: 'asset-1' });
  });
});
