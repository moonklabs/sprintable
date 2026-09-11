// [SID:3807] 슬라이스12 AC2 — 리다이렉트 0·Content-Type application/json 정확히(no-store)·
// 원문 그대로 중계(재조립 0)·업스트림 실패 시 502(깨진 200 아님) 회귀가드.
import { describe, expect, it, vi } from 'vitest';

const { fetchDesktopUpdateManifestMock } = vi.hoisted(() => ({
  fetchDesktopUpdateManifestMock: vi.fn(),
}));
vi.mock('@/lib/desktop-updates', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/desktop-updates')>();
  return { ...actual, fetchDesktopUpdateManifest: fetchDesktopUpdateManifestMock };
});

import { GET } from './route';
import { DesktopManifestUnavailableError } from '@/lib/desktop-updates';

describe('GET /desktop/updates/macos.json', () => {
  it('relays the GCS manifest verbatim with 200 + application/json + no-store, no redirect', async () => {
    fetchDesktopUpdateManifestMock.mockResolvedValue('{"version":"9.9.9"}');
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Location')).toBeNull();
    const body = await res.text();
    expect(body).toBe('{"version":"9.9.9"}');
  });

  it('fails loud (502, not a broken 200) when the GCS manifest is unavailable', async () => {
    fetchDesktopUpdateManifestMock.mockRejectedValue(new DesktopManifestUnavailableError('boom'));
    const res = await GET();
    expect(res.status).toBe(502);
  });
});
