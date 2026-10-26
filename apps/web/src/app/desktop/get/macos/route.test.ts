// story #4763 (PO 10-26) — the public door to the Mac app download: a redirect to the manifest's own url and nothing else.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchManifest } = vi.hoisted(() => ({ fetchManifest: vi.fn() }));
vi.mock('@/lib/desktop-downloads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/desktop-downloads')>();
  return { ...actual, fetchDesktopDownloadManifest: fetchManifest };
});

import { GET } from './route';

const BUCKET = 'sprintable-desktop-releases-dev';
const DMG = `https://storage.googleapis.com/${BUCKET}/macos-electron/0.2.0/Sprintable-Dev-Setup-f0a17c077-arm64.dmg`;
const manifest = (url: unknown) => JSON.stringify({ product: 'Sprintable Dev Setup', version: '0.2.0', build: 'f0a17c077', url, sha256: 'ff'.repeat(32), size: 1, pub_date: '2026-10-25T23:29:54.456Z' });

beforeEach(() => { process.env.DESKTOP_DOWNLOAD_ENABLED = 'true'; process.env.DESKTOP_DOWNLOAD_BUCKET = BUCKET; vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { delete process.env.DESKTOP_DOWNLOAD_ENABLED; delete process.env.DESKTOP_DOWNLOAD_BUCKET; fetchManifest.mockReset(); vi.restoreAllMocks(); });

describe('GET /desktop/get/macos (public)', () => {
  it('redirects to the manifest\'s url — and says nothing else: empty body, not the manifest (no sha256 · build · version), no-store', async () => {
    fetchManifest.mockResolvedValue(manifest(DMG));
    const res = await GET();
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(DMG);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.text()).toBe('');
    expect(fetchManifest.mock.calls[0]![1]).toBe(BUCKET); // the server's own bucket
  });

  it('the download is off on this deployment (switch not exactly "true" · prod today): 404 and the manifest is not even read', async () => {
    for (const v of [undefined, '', 'false', 'TRUE', '1']) {
      if (v === undefined) delete process.env.DESKTOP_DOWNLOAD_ENABLED; else process.env.DESKTOP_DOWNLOAD_ENABLED = v;
      const res = await GET();
      expect(res.status, String(v)).toBe(404);
      expect(res.headers.get('Location')).toBeNull();
    }
    expect(fetchManifest).not.toHaveBeenCalled();
  });

  it('a manifest url that is not ours is never redirected to: another host · another bucket · a bucket named like ours · a non-https · user-info · a path climbing out · not a string — all 502', async () => {
    for (const url of [
      'https://evil.example/x.dmg',
      'https://storage.googleapis.com/other-bucket/x.dmg',
      `https://storage.googleapis.com/${BUCKET}-evil/x.dmg`,
      `http://storage.googleapis.com/${BUCKET}/x.dmg`,
      `https://user:pw@storage.googleapis.com/${BUCKET}/x.dmg`,
      `https://storage.googleapis.com/${BUCKET}/../other-bucket/x.dmg`,
      `https://storage.googleapis.com/${BUCKET}/`,
      42, null, undefined,
    ]) {
      fetchManifest.mockResolvedValue(manifest(url));
      const res = await GET();
      expect(res.status, String(url)).toBe(502);
      expect(res.headers.get('Location'), String(url)).toBeNull();
      expect(await res.text(), String(url)).toBe(''); // never the manifest, never an error text
    }
  });

  // Kadir's lens: a failure is logged by the error's NAME only — an error whose message carries a url or a token must not reach the log arguments (nor the error object itself)
  it('a failed read logs the error name only — not the error object, not its message (secret-bearing message or body)', async () => {
    const log = vi.mocked(console.error);
    const SECRET = 'SECRET-TOKEN-4763';
    fetchManifest.mockRejectedValue(new Error(`GCS fetch failed for https://storage.googleapis.com/${BUCKET}/x?token=${SECRET}`));
    await GET();
    fetchManifest.mockResolvedValue(`not json ${SECRET}`); // a SyntaxError message may quote the text it choked on
    await GET();
    expect(log).toHaveBeenCalledTimes(2);
    const args = log.mock.calls.flat();
    expect(args.some((a) => typeof a === 'object' && a !== null)).toBe(false); // no error object
    expect(args.map(String).join('|')).not.toContain(SECRET);
    expect(log.mock.calls.map((c) => c[1])).toEqual(['Error', 'SyntaxError']);
  });

  it('no bucket configured · the manifest cannot be read · the body is not JSON · the body is not an object: 502, no redirect, no body', async () => {
    for (const bucket of [undefined, '', 'a/b']) { // no bucket named = nothing is ours: 502, empty, and the manifest is not even read
      if (bucket === undefined) delete process.env.DESKTOP_DOWNLOAD_BUCKET; else process.env.DESKTOP_DOWNLOAD_BUCKET = bucket;
      fetchManifest.mockResolvedValue(manifest(DMG)); // even with a good-looking manifest
      const res = await GET();
      expect(res.status, String(bucket)).toBe(502);
      expect(res.headers.get('Location'), String(bucket)).toBeNull();
      expect(await res.text(), String(bucket)).toBe('');
    }
    expect(fetchManifest).not.toHaveBeenCalled();
    process.env.DESKTOP_DOWNLOAD_BUCKET = BUCKET;
    fetchManifest.mockRejectedValue(new Error('boom'));
    const failed = await GET();
    expect(failed.status).toBe(502);
    expect(await failed.text()).toBe(''); // the error text stays in the server log
    for (const body of ['not json', 'null', '[]', '"x"']) {
      fetchManifest.mockResolvedValue(body);
      const res = await GET();
      expect(res.status, body).toBe(502);
      expect(await res.text(), body).toBe('');
    }
  });
});
