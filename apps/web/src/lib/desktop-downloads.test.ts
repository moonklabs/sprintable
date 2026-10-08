// [SID:4619] AC2 — the download manifest is read from macos-electron/latest (the Electron app), and the old Tauri updater's
// manifest (desktop-updates.ts · macos/latest/macos.json) is a different place that this card no longer reads.
import { describe, expect, it, vi } from 'vitest';
import { DesktopDownloadUnavailableError, fetchDesktopDownloadManifest } from './desktop-downloads';

describe('fetchDesktopDownloadManifest', () => {
  it('reads macos-electron/latest/manifest.json past the cache (no-store · a new query each call) and returns the body as it is', async () => {
    const body = '{\n  "version": "0.2.0"\n}\n';
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, text: async () => body });
    expect(await fetchDesktopDownloadManifest(mockFetch as unknown as typeof fetch)).toBe(body);
    await fetchDesktopDownloadManifest(mockFetch as unknown as typeof fetch);
    const [[url1, opts], [url2]] = mockFetch.mock.calls as [string, RequestInit][];
    expect(opts).toEqual({ cache: 'no-store' });
    expect(url1).toMatch(/^https:\/\/storage\.googleapis\.com\/sprintable-desktop-releases-dev\/macos-electron\/latest\/manifest\.json\?_t=\d+-[a-z0-9]+$/);
    expect(url1).not.toBe(url2);
  });

  it('throws DesktopDownloadUnavailableError on a non-2xx (a missing object is not a broken 200)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });
    await expect(fetchDesktopDownloadManifest(mockFetch as unknown as typeof fetch)).rejects.toThrow(DesktopDownloadUnavailableError);
  });
});
