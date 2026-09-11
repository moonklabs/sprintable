// [SID:3807] 슬라이스12 AC2 — GCS 공개읽기 버킷(mobile 레포 CI가 채움) 중계 순수 로직.
import { describe, expect, it, vi } from 'vitest';
import { DesktopManifestUnavailableError, fetchDesktopUpdateManifest } from './desktop-updates';

// [SID:3807] 카디르 QA #4187 발견 ③ — 압축형 2키 JSON은 parse→stringify 재조립을 해도
// 바이트가 우연히 같아 "원문 그대로" 뮤테이션가드가 공허통과한다. mobile CI의 실 macos.json은
// jq가 2칸 들여쓰기로 찍는다(pretty-print) — 그 실제 모양을 픽스처로 써서 재조립이 일어나면
// (들여쓰기 손실) 반드시 바이트가 달라지게 한다.
const FIXTURE_MANIFEST = '{\n  "version": "0.1.0",\n  "pub_date": "2026-09-11T00:00:00Z",\n  "platforms": {\n    "darwin-aarch64": {\n      "signature": "abc",\n      "url": "https://example/x"\n    }\n  }\n}\n';

describe('fetchDesktopUpdateManifest', () => {
  it('returns the GCS manifest body verbatim on success — no reparsing/reassembly', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => FIXTURE_MANIFEST,
    });
    const body = await fetchDesktopUpdateManifest(mockFetch as unknown as typeof fetch);
    expect(body).toBe(FIXTURE_MANIFEST);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://storage.googleapis.com/sprintable-desktop-releases-dev/macos/latest/macos.json',
      { cache: 'no-store' },
    );
  });

  it('throws DesktopManifestUnavailableError when GCS returns non-2xx — mutation guard: bucket object missing/gone must not surface as a broken 200', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });
    await expect(
      fetchDesktopUpdateManifest(mockFetch as unknown as typeof fetch),
    ).rejects.toThrow(DesktopManifestUnavailableError);
  });
});
