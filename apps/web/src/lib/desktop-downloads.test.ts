// [SID:4619] AC2 — the download manifest is read from macos-electron/latest (the Electron app), and the old Tauri updater's
// manifest (desktop-updates.ts · macos/latest/macos.json) is a different place that this card no longer reads.
import { describe, expect, it, vi } from 'vitest';
import { DesktopDownloadUnavailableError, fetchDesktopDownloadManifest, ourDownloadUrl } from './desktop-downloads';

// [SID:4619 · Kadir 5004 후속 ①] the manifest is relayed as it is — the card links its url only when it is in our bucket
describe('ourDownloadUrl', () => {
  const OURS = 'https://storage.googleapis.com/sprintable-desktop-releases-dev/macos-electron/0.2.0/Sprintable-Dev-Setup-abc123def-arm64.dmg';
  it('our bucket over https: linked (as the parsed href)', () => {
    expect(ourDownloadUrl(OURS)).toBe(OURS);
  });
  it.each([
    ['another host', 'https://evil.example/sprintable-desktop-releases-dev/x.dmg'],
    ['http', OURS.replace('https:', 'http:')],
    ['data:', 'data:application/x-apple-diskimage;base64,AAAA'],
    ['javascript:', 'javascript:alert(1)'],
    ['a bucket whose name only starts the same', 'https://storage.googleapis.com/sprintable-desktop-releases-dev-evil/x.dmg'],
    ['«..» out of the bucket', 'https://storage.googleapis.com/sprintable-desktop-releases-dev/../evil/x.dmg'],
    ['an encoded «..» out of the bucket', 'https://storage.googleapis.com/sprintable-desktop-releases-dev/%2e%2e/evil/x.dmg'],
    ['another host behind a user-info part', 'https://storage.googleapis.com@evil.example/sprintable-desktop-releases-dev/x.dmg'],
    ['our host with a user-info part', 'https://u:p@storage.googleapis.com/sprintable-desktop-releases-dev/x.dmg'],
    ['another port', 'https://storage.googleapis.com:8443/sprintable-desktop-releases-dev/x.dmg'],
    ['the bucket itself, no file', 'https://storage.googleapis.com/sprintable-desktop-releases-dev/'],
    ['not a url', 'Sprintable.dmg'],
    ['not a string', 42],
    ['nothing', undefined],
  ])('%s: not linked', (_name, url) => {
    expect(ourDownloadUrl(url)).toBeNull();
  });
});

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
