// @vitest-environment jsdom
//
// story #2887(S2g) — avatar 3단 계약(발급→PUT→confirm) 클라 오케스트레이션 + 삭제 회귀가드.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { removeAvatar, uploadAvatar } from './avatar-upload';

class FakeXHR {
  static instances: FakeXHR[] = [];
  method = '';
  url = '';
  status = 200;
  headers: Record<string, string> = {};
  upload = { onprogress: null as ((e: ProgressEvent) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  open(method: string, url: string) { this.method = method; this.url = url; FakeXHR.instances.push(this); }
  setRequestHeader(k: string, v: string) { this.headers[k] = v; }
  send() {
    this.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 } as ProgressEvent);
    this.upload.onprogress?.({ lengthComputable: true, loaded: 100, total: 100 } as ProgressEvent);
    this.onload?.();
  }
}

beforeEach(() => {
  FakeXHR.instances = [];
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('uploadAvatar — story #2887 S2g', () => {
  it('3단(발급→PUT→confirm)을 순서대로 호출하고 새 avatar_url을 반환한다', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.includes('upload-url')) {
        return {
          ok: true,
          json: async () => ({ data: { upload_url: 'https://gcs.example.com/put', object_path: 'avatar/o/m/x.png', public_url: 'https://cdn/x.png', expires_at: '2026-01-01', max_bytes: 5242880 } }),
        } as Response;
      }
      if (url.includes('confirm')) {
        return { ok: true, json: async () => ({ data: { avatar_url: 'https://cdn/x.png' } }) } as Response;
      }
      throw new Error(`unexpected url ${url}`);
    }));

    const progressSamples: number[] = [];
    const result = await uploadAvatar('member-1', new Blob(['x']), 'image/png', (pct) => progressSamples.push(pct));

    expect(result).toBe('https://cdn/x.png');
    expect(calls).toEqual([
      'POST /api/team-members/member-1/avatar/upload-url',
      'POST /api/team-members/member-1/avatar/confirm',
    ]);
    expect(FakeXHR.instances).toHaveLength(1);
    expect(FakeXHR.instances[0]!.method).toBe('PUT');
    expect(FakeXHR.instances[0]!.url).toBe('https://gcs.example.com/put');
    expect(FakeXHR.instances[0]!.headers['Content-Type']).toBe('image/png');
    expect(progressSamples).toEqual([50, 100]);
  });

  it('upload-url 발급 실패 시 에러를 던지고 PUT을 시도하지 않는다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      json: async () => ({ data: { code: 'UNSUPPORTED_CONTENT_TYPE', message: 'nope' } }),
    } as Response)));

    await expect(uploadAvatar('member-1', new Blob(['x']), 'image/png')).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT_TYPE' });
    expect(FakeXHR.instances).toHaveLength(0);
  });

  // story #3601(디디 전수 표 2026-09-07) — 실 BE 봉투({data:null,error:{code,message},
  // meta:null}, BE 전역 http_exception_handler 그대로)에서 code는 이제 살아 뜬다
  // (이전엔 `json.data ?? json.detail ?? fallback`이 .error를 아예 안 봐 code까지
  // "UNKNOWN"으로 떨어졌다).
  //
  // 페드루 PO 정정(2026-09-07, 유나 Design CHANGES) — 그러나 message는 그대로
  // 보이면 안 된다: UNSUPPORTED_CONTENT_TYPE의 실제 BE 원문(avatar_upload.py:72)은
  // "허용되지 않는 content_type: 'image/gif' (허용: [...])"로 내부 필드명·raw
  // repr을 그대로 담는다 — 사람 문장이 아니다. 공용 allowlist(HUMAN_SAFE_ERROR_
  // MESSAGE_CODES) 밖이라 message는 제네릭("HTTP 422")으로 떨어져야 정답.
  it('upload-url 발급 실패(실 봉투 {error:{code,message}}) — code는 살고 message는 allowlist 밖이라 제네릭', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 422,
      json: async () => ({ data: null, error: { code: 'UNSUPPORTED_CONTENT_TYPE', message: "허용되지 않는 content_type: 'image/gif' (허용: ['image/jpeg', 'image/png', 'image/webp'])" }, meta: null }),
    } as Response)));

    await expect(uploadAvatar('member-1', new Blob(['x']), 'image/png'))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT_TYPE', message: 'HTTP 422' });
    expect(FakeXHR.instances).toHaveLength(0);
  });

  it('PUT 실패(XHR 비2xx) 시 confirm을 호출하지 않고 에러를 던진다', async () => {
    class FailingPutXHR extends FakeXHR {
      send() { this.status = 403; this.onload?.(); }
    }
    vi.stubGlobal('XMLHttpRequest', FailingPutXHR);
    const confirmCalled = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('upload-url')) {
        return { ok: true, json: async () => ({ data: { upload_url: 'https://gcs/put', object_path: 'p', public_url: 'u', expires_at: 't', max_bytes: 1 } }) } as Response;
      }
      confirmCalled();
      return { ok: true, json: async () => ({ data: { avatar_url: null } }) } as Response;
    }));

    await expect(uploadAvatar('member-1', new Blob(['x']), 'image/png')).rejects.toMatchObject({ code: 'PUT_FAILED' });
    expect(confirmCalled).not.toHaveBeenCalled();
  });
});

describe('removeAvatar — story #2887 S2g', () => {
  it('DELETE 호출 성공', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ data: {} }) } as Response));
    vi.stubGlobal('fetch', fetchMock);
    await removeAvatar('member-1');
    expect(fetchMock).toHaveBeenCalledWith('/api/team-members/member-1/avatar', expect.objectContaining({ method: 'DELETE' }));
  });

  it('DELETE 실패 시 에러를 던진다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({ data: { code: 'FORBIDDEN', message: 'no' } }) } as Response)));
    await expect(removeAvatar('member-1')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
