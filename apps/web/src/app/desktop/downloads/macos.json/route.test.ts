// [SID:4619] AC2 — the download manifest relay: 200 + application/json + no-store, the body as it is, 502 when GCS fails.
import { afterEach, describe, expect, it, vi } from 'vitest';

const { fetchDesktopDownloadManifestMock } = vi.hoisted(() => ({ fetchDesktopDownloadManifestMock: vi.fn() }));
vi.mock('@/lib/desktop-downloads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/desktop-downloads')>();
  return { ...actual, fetchDesktopDownloadManifest: fetchDesktopDownloadManifestMock };
});

import { GET } from './route';
import { DesktopDownloadUnavailableError } from '@/lib/desktop-downloads';

// the shape publish-dev-setup.mjs writes (JSON.stringify(…, null, 2) + newline) — a re-serialisation would change the bytes
const FIXTURE = '{\n  "product": "Sprintable Dev Setup",\n  "version": "0.2.0",\n  "build": "abc123def",\n  "url": "https://example/x.dmg",\n  "sha256": "ff",\n  "pub_date": "2026-10-08T03:00:00.000Z"\n}\n';

afterEach(() => { delete process.env.DESKTOP_DOWNLOAD_BUCKET; fetchDesktopDownloadManifestMock.mockReset(); });

describe('GET /desktop/downloads/macos.json', () => {
  it('relays the GCS manifest as it is with 200 + application/json + no-store, no redirect', async () => {
    fetchDesktopDownloadManifestMock.mockResolvedValue(FIXTURE);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Location')).toBeNull();
    expect(await res.text()).toBe(FIXTURE);
  });

  // story 4696: the bucket is the server's setting — read from the env, handed to the fetch, and told to the card in a header
  it('the configured bucket goes to the fetch and to the card (header); none configured → the fetch gets null (it closes) and the header is empty', async () => {
    fetchDesktopDownloadManifestMock.mockResolvedValue(FIXTURE);
    process.env.DESKTOP_DOWNLOAD_BUCKET = 'sprintable-desktop-releases';
    const res = await GET();
    expect(res.headers.get('x-desktop-download-bucket')).toBe('sprintable-desktop-releases');
    expect(fetchDesktopDownloadManifestMock.mock.calls.at(-1)![1]).toBe('sprintable-desktop-releases');
    delete process.env.DESKTOP_DOWNLOAD_BUCKET;
    fetchDesktopDownloadManifestMock.mockRejectedValue(new DesktopDownloadUnavailableError('no bucket'));
    expect((await GET()).status).toBe(502);
    expect(fetchDesktopDownloadManifestMock.mock.calls.at(-1)![1]).toBeNull();
  });

  it('fails loud (502, not a broken 200) when the GCS manifest is unavailable', async () => {
    fetchDesktopDownloadManifestMock.mockRejectedValue(new DesktopDownloadUnavailableError('boom'));
    expect((await GET()).status).toBe(502);
  });
});
