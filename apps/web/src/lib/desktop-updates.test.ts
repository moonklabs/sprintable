// [SID:3807] 슬라이스12 AC2 — GCS 공개읽기 버킷(mobile 레포 CI가 채움) 중계 순수 로직.
import { describe, expect, it, vi } from 'vitest';
import { DesktopManifestUnavailableError, fetchDesktopUpdateManifest } from './desktop-updates';

describe('fetchDesktopUpdateManifest', () => {
  it('returns the GCS manifest body verbatim on success — no reparsing/reassembly', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => '{"version":"0.1.0","pub_date":"2026-09-11T00:00:00Z"}',
    });
    const body = await fetchDesktopUpdateManifest(mockFetch as unknown as typeof fetch);
    expect(body).toBe('{"version":"0.1.0","pub_date":"2026-09-11T00:00:00Z"}');
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
