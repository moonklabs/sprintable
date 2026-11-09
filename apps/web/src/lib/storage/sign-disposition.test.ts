import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isSafeInlineType, resetSignDispositionCache, resolveReadDisposition } from './sign-disposition';

beforeEach(() => resetSignDispositionCache());

describe('[SID:4860] isSafeInlineType — the allow list of stored types that may be opened inline', () => {
  it.each([
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'image/avif',
    'image/bmp',
    'application/pdf',
    'text/plain',
    'IMAGE/PNG',
    '  image/png  ',
    'text/plain; charset=utf-8',
    'Text/Plain ;charset=UTF-8',
    'application/pdf; foo=bar',
    'audio/mpeg',
    'audio/ogg; codecs=opus',
    'AUDIO/MPEG',
    'audio/x-wav',
    'audio/mp4',
    'video/mp4',
    'video/webm',
    'video/quicktime',
  ])('%s → inline', (t) => {
    expect(isSafeInlineType(t)).toBe(true);
  });

  // the eight strings the security review (kadir) opened in a real Chrome: each is answered by looking at the content, and markup there runs its script
  it.each([
    'application/unknown',
    'unknown/unknown',
    '*/*',
    'text/xsl',
    'html',
    'text',
    'text /html',
    '',
  ])('review string %j → not inline', (t) => {
    expect(isSafeInlineType(t)).toBe(false);
  });

  it('the review\'s «no Content-Type» (null · undefined) → not inline', () => {
    expect(isSafeInlineType(null)).toBe(false);
    expect(isSafeInlineType(undefined)).toBe(false);
  });

  it.each([
    'text/html',
    'TEXT/HTML',
    'text/html; charset=utf-8',
    'application/xhtml+xml',
    'image/svg+xml',
    'Image/SVG+XML; charset=utf-8',
    'text/xml',
    'application/xml',
    'application/mathml+xml',
    'application/rss+xml',
  ])('markup %s → not inline', (t) => {
    expect(isSafeInlineType(t)).toBe(false);
  });

  it.each([
    'application/octet-stream',
    'binary/octet-stream',
    'application/json',
    'application/javascript',
    'text/javascript',
    'text/markdown',
    'text/csv',
    'text/css',
    'application/zip',
    'font/woff2',
    'model/gltf+json',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/svg',
    'image/x-icon',
    'image/tiff',
    'application/x-shockwave-flash',
  ])('a type that is not on the list, %s → not inline', (t) => {
    expect(isSafeInlineType(t)).toBe(false);
  });

  it.each([
    'image/*',
    'audio/*',
    'video/*',
    'audio/',
    'audio',
    'video/ mp4',
    'audio/x y',
    'audio/mpeg, text/html',
    'image/png, text/html',
    'image/png text/html',
    'text/plain, text/html',
    'application/pdf,text/html',
    'audio/mpeg\ntext/html',
    'video/../html',
    'text/html audio/mpeg',
    'x video/mp4',
    'text/audio/mpeg',
    'text/video/mp4',
  ])(
    'a malformed or doubled string, %j → not inline',
    (t) => {
      expect(isSafeInlineType(t)).toBe(false);
    },
  );

  // found by the codex review of the allow-list head: a `+xml` subtype is an XML type under any type before the slash
  it.each(['audio/svg+xml', 'video/xhtml+xml', 'audio/mathml+xml', 'video/vnd.example+xml', 'audio/mpeg+xml'])('a media type with a +xml subtype, %s → not inline', (t) => {
    expect(isSafeInlineType(t)).toBe(false);
  });

  // found by the same review: JavaScript's trim and lower-case strip or fold characters a browser reads differently, so a string that is not printable ASCII is not judged at all
  // the odd characters are built from code points (a literal one would be lost or folded by an editor or a pasted probe)
  const U = (...codes: number[]) => String.fromCodePoint(...codes);
  it.each([
    [`${U(0xa0)}image/png${U(0xa0)}`, 'no-break space around a listed type'],
    [`image/png${U(0xa0)}`, 'no-break space after'],
    [`${U(0x2003)}text/plain`, 'em space before'],
    [`text/plain${U(0x200b)}`, 'zero-width space after'],
    [`application/pdf${U(0x2028)}`, 'line separator after'],
    [`image/png${U(0)}`, 'NUL after'],
    ['image/png\t', 'tab after'],
    ['image/png\n', 'line feed after'],
    ['image/png\r\n', 'CR LF after'],
    [' \timage/png', 'space and tab before'],
    [`image/png; charset=${U(0xe9)}`, 'non-ASCII in a parameter'],
    [`video/m${U(0x212a)}v`, 'Kelvin sign (lower-cases to an ASCII k)'],
    [`${U(0x130)}MAGE/PNG`, 'dotted capital I (lower-cases to i plus a combining dot)'],
    [`image/p${U(0x131)}ng`, 'dotless i'],
  ])('a non-ASCII or control character: %j (%s) → not inline', (t) => {
    expect(isSafeInlineType(t)).toBe(false);
  });

  it('an ordinary space around a listed type is still judged (HTTP trims it)', () => {
    expect(isSafeInlineType(' image/png ')).toBe(true);
    expect(isSafeInlineType('image/png ; charset=x')).toBe(true);
  });
});

describe('[SID:4860] resolveReadDisposition', () => {
  const head = (contentType: string | null) => ({ headObject: vi.fn(async () => ({ size: 1, contentType })) });

  it.each(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'application/pdf', 'text/plain', 'audio/mpeg', 'video/mp4'])(
    'a stored %s keeps inline',
    async (t) => {
      expect(await resolveReadDisposition(head(t), 'b', 'o/x', 'inline')).toBe('inline');
    },
  );

  it.each([
    'text/html',
    'image/svg+xml',
    'application/xhtml+xml',
    'text/xml',
    'application/unknown',
    'unknown/unknown',
    '*/*',
    'text/xsl',
    'html',
    'text',
    'text /html',
    'application/octet-stream',
    'application/json',
    'text/markdown',
    null,
    '',
  ])('a stored %j is signed as a download even when the caller asked for inline', async (t) => {
    expect(await resolveReadDisposition(head(t), 'b', 'o/x', 'inline')).toBe('attachment');
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
