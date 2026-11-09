import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isActiveDocumentType, resetSignDispositionCache, resolveReadDisposition } from './sign-disposition';

beforeEach(() => resetSignDispositionCache());

describe('[SID:4860] isActiveDocumentType — the stored types a browser draws as a script-capable document', () => {
  it.each([
    'text/html',
    'TEXT/HTML',
    'text/html; charset=utf-8',
    '  text/html ;charset=UTF-8',
    'application/xhtml+xml',
    'image/svg+xml',
    'Image/SVG+XML; charset=utf-8',
    'text/xml',
    'application/xml',
    'application/mathml+xml',
    'application/rss+xml',
    'application/vnd.wap.xhtml+xml',
  ])('%s → active', (t) => {
    expect(isActiveDocumentType(t)).toBe(true);
  });

  it.each([
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'application/pdf',
    'text/plain',
    'text/markdown',
    'text/javascript',
    'application/json',
    'application/octet-stream',
    'video/mp4',
    'audio/mpeg',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/htmlx',
    'xml',
    '',
  ])('%s → not active', (t) => {
    expect(isActiveDocumentType(t)).toBe(false);
  });

  it('null and undefined (no type recorded) → not active', () => {
    expect(isActiveDocumentType(null)).toBe(false);
    expect(isActiveDocumentType(undefined)).toBe(false);
  });
});

describe('[SID:4860] resolveReadDisposition', () => {
  const head = (contentType: string | null) => ({ headObject: vi.fn(async () => ({ size: 1, contentType })) });

  it.each(['text/html', 'image/svg+xml', 'application/xhtml+xml', 'text/xml'])('a stored %s is signed as a download even when the caller asked for inline', async (t) => {
    expect(await resolveReadDisposition(head(t), 'b', 'o/x', 'inline')).toBe('attachment');
  });

  it.each(['image/png', 'image/jpeg', 'application/pdf', 'text/plain', 'application/octet-stream', null])('a stored %s keeps inline', async (t) => {
    expect(await resolveReadDisposition(head(t), 'b', 'o/x', 'inline')).toBe('inline');
  });

  it('a caller that asked for attachment keeps it for every type, and the storage service is not asked', async () => {
    const s = head('image/png');
    expect(await resolveReadDisposition(s, 'b', 'o/x', 'attachment')).toBe('attachment');
    expect(s.headObject).not.toHaveBeenCalled();
  });

  it('a type that cannot be read (the storage service throws) is not drawn as a page: attachment', async () => {
    const s = { headObject: vi.fn(async () => { throw new Error('storage.objects.get denied'); }) };
    expect(await resolveReadDisposition(s, 'b', 'o/x', 'inline')).toBe('attachment');
  });

  it('a failure is not remembered: the next call asks again and a picture then keeps inline', async () => {
    const calls: Array<() => Promise<{ size: number; contentType: string | null }>> = [
      async () => { throw new Error('transient'); },
      async () => ({ size: 1, contentType: 'image/png' }),
    ];
    const s = { headObject: vi.fn(() => calls.shift()!()) };
    expect(await resolveReadDisposition(s, 'b', 'o/x', 'inline')).toBe('attachment');
    expect(await resolveReadDisposition(s, 'b', 'o/x', 'inline')).toBe('inline');
    expect(s.headObject).toHaveBeenCalledTimes(2);
  });

  it('no such object (null) → the requested disposition (nothing to serve)', async () => {
    const s = { headObject: vi.fn(async () => null) };
    expect(await resolveReadDisposition(s, 'b', 'o/x', 'inline')).toBe('inline');
  });

  it('the answer is remembered per object: one storage question for many signs of the same file', async () => {
    const s = head('image/svg+xml');
    expect(await resolveReadDisposition(s, 'b', 'o/x.svg', 'inline')).toBe('attachment');
    expect(await resolveReadDisposition(s, 'b', 'o/x.svg', 'inline')).toBe('attachment');
    expect(await resolveReadDisposition(s, 'b', 'o/y.svg', 'inline')).toBe('attachment');
    expect(s.headObject).toHaveBeenCalledTimes(2);
  });

  it('the memory ends after ten minutes: the storage service is asked again', async () => {
    vi.useFakeTimers();
    try {
      const s = head('image/png');
      await resolveReadDisposition(s, 'b', 'o/x', 'inline');
      vi.advanceTimersByTime(9 * 60 * 1000);
      await resolveReadDisposition(s, 'b', 'o/x', 'inline');
      expect(s.headObject).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(2 * 60 * 1000);
      await resolveReadDisposition(s, 'b', 'o/x', 'inline');
      expect(s.headObject).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the memory is bounded: after 500 other files the oldest one is asked about again, a recent one is not', async () => {
    const s = head('image/png');
    await resolveReadDisposition(s, 'b', 'first', 'inline');
    for (let i = 0; i < 500; i++) await resolveReadDisposition(s, 'b', `other-${i}`, 'inline');
    expect(s.headObject).toHaveBeenCalledTimes(501);
    await resolveReadDisposition(s, 'b', 'other-499', 'inline'); // recent: remembered
    expect(s.headObject).toHaveBeenCalledTimes(501);
    await resolveReadDisposition(s, 'b', 'first', 'inline'); // oldest: pushed out
    expect(s.headObject).toHaveBeenCalledTimes(502);
  });

  it('the same object path in another container is another object', async () => {
    const s = head('text/html');
    await resolveReadDisposition(s, 'b1', 'o/x', 'inline');
    await resolveReadDisposition(s, 'b2', 'o/x', 'inline');
    expect(s.headObject).toHaveBeenCalledTimes(2);
  });
});
