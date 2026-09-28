/**
 * Unit tests for page-embed-node.tsx
 *
 * Focuses on pure exported helpers — isSelfEmbed and attribute parseHTML logic.
 * The Tiptap extension itself and the React node view require a browser
 * environment (jsdom + full editor setup) and are covered by smoke testing.
 */
import { describe, expect, it } from 'vitest';
import { isSelfEmbed } from './page-embed-node';

describe('isSelfEmbed — self-embed (A embeds A) · [SID:4381] 간접 순환 판정은 걷음', () => {
  it('returns true when docId matches currentDocId', () => {
    expect(isSelfEmbed('doc-abc', 'doc-abc')).toBe(true);
  });

  it('returns false when docId differs from currentDocId', () => {
    expect(isSelfEmbed('doc-abc', 'doc-xyz')).toBe(false);
  });

  it('returns false when docId is null (no doc selected yet)', () => {
    expect(isSelfEmbed(null, 'doc-abc')).toBe(false);
  });

  it('returns false when docId is undefined', () => {
    expect(isSelfEmbed(undefined, 'doc-abc')).toBe(false);
  });

  it('returns false when currentDocId is undefined (editor not bound to a doc)', () => {
    expect(isSelfEmbed('doc-abc', undefined)).toBe(false);
  });

  it('returns false when both are undefined', () => {
    expect(isSelfEmbed(undefined, undefined)).toBe(false);
  });

  it('returns false when both are null/undefined mix', () => {
    expect(isSelfEmbed(null, undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// addAttributes parseHTML — round-trip simulation
//
// The per-attribute parseHTML functions must correctly extract attrs from HTML
// produced by the turndown pageEmbed rule (data-* only, no docid/title/etc.).
// This is the regression that caused the "새로고침 시 picker 복귀" smoke failure.
// ---------------------------------------------------------------------------

/**
 * Simulate what Tiptap's per-attribute parseHTML receives.
 * vitest runs in Node (no DOM), so we mock only getAttribute.
 */
function makeEl(attrs: Record<string, string>): Element {
  return {
    getAttribute: (name: string) => attrs[name] ?? null,
  } as unknown as Element;
}

describe('addAttributes parseHTML — markdown round-trip (data-* attrs only)', () => {
  // These are the parseHTML functions from addAttributes — tested as standalone lambdas
  // mirroring the exact attribute definitions in page-embed-node.tsx.
  const parseDocId = (el: Element) => el.getAttribute('data-doc-id') || el.getAttribute('docid') || null;
  const parseTitle = (el: Element) => el.getAttribute('data-title') || null;
  const parseIcon  = (el: Element) => el.getAttribute('data-icon')  || null;
  const parseSlug  = (el: Element) => el.getAttribute('data-slug')  || null;

  it('reads docId from data-doc-id (markdown round-trip path)', () => {
    const el = makeEl({ 'data-page-embed': '', 'data-doc-id': 'abc-123', 'data-title': 'My Doc', 'data-icon': '📄', 'data-slug': 'my-doc' });
    expect(parseDocId(el)).toBe('abc-123');
  });

  it('reads docId from legacy docid attr (HTML format path)', () => {
    const el = makeEl({ 'data-page-embed': '', docid: 'abc-123' });
    expect(parseDocId(el)).toBe('abc-123');
  });

  it('returns null when neither data-doc-id nor docid present', () => {
    const el = makeEl({ 'data-page-embed': '' });
    expect(parseDocId(el)).toBeNull();
  });

  it('reads title from data-title', () => {
    const el = makeEl({ 'data-title': 'My Document' });
    expect(parseTitle(el)).toBe('My Document');
  });

  it('returns null for title when attr absent', () => {
    expect(parseTitle(makeEl({}))).toBeNull();
  });

  it('reads icon from data-icon', () => {
    const el = makeEl({ 'data-icon': '📄' });
    expect(parseIcon(el)).toBe('📄');
  });

  it('returns null for icon when attr absent', () => {
    expect(parseIcon(makeEl({}))).toBeNull();
  });

  it('reads slug from data-slug', () => {
    const el = makeEl({ 'data-slug': 'my-doc' });
    expect(parseSlug(el)).toBe('my-doc');
  });

  it('returns null for slug when attr absent', () => {
    expect(parseSlug(makeEl({}))).toBeNull();
  });

  it('full markdown round-trip: all four attrs survive data-* only element', () => {
    const el = makeEl({
      'data-page-embed': '',
      'data-doc-id': 'doc-xyz',
      'data-title': 'API Reference',
      'data-icon': '📚',
      'data-slug': 'api-reference',
    });
    expect(parseDocId(el)).toBe('doc-xyz');
    expect(parseTitle(el)).toBe('API Reference');
    expect(parseIcon(el)).toBe('📚');
    expect(parseSlug(el)).toBe('api-reference');
  });
});
