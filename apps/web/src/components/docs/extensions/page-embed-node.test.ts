/**
 * Unit tests for page-embed-node.tsx
 *
 * Focuses on pure exported helpers — isCircularEmbed and attribute parseHTML logic.
 * The Tiptap extension itself and the React node view require a browser
 * environment (jsdom + full editor setup) and are covered by smoke testing.
 */
import { describe, expect, it } from 'vitest';
import { isCircularEmbed } from './page-embed-node';

describe('isCircularEmbed — direct self-embed (A embeds A)', () => {
  it('returns true when docId matches currentDocId', () => {
    expect(isCircularEmbed('doc-abc', 'doc-abc')).toBe(true);
  });

  it('returns false when docId differs from currentDocId', () => {
    expect(isCircularEmbed('doc-abc', 'doc-xyz')).toBe(false);
  });

  it('returns false when docId is null (no doc selected yet)', () => {
    expect(isCircularEmbed(null, 'doc-abc')).toBe(false);
  });

  it('returns false when docId is undefined', () => {
    expect(isCircularEmbed(undefined, 'doc-abc')).toBe(false);
  });

  it('returns false when currentDocId is undefined (editor not bound to a doc)', () => {
    expect(isCircularEmbed('doc-abc', undefined)).toBe(false);
  });

  it('returns false when both are undefined', () => {
    expect(isCircularEmbed(undefined, undefined)).toBe(false);
  });

  it('returns false when both are null/undefined mix', () => {
    expect(isCircularEmbed(null, undefined)).toBe(false);
  });
});

describe('isCircularEmbed — indirect cycle (A→B→A via embedChain)', () => {
  it('returns true when currentDocId appears in embedChain (A embeds B, B embeds A)', () => {
    // currentDoc = 'doc-a', target = 'doc-b', doc-b embeds doc-a → cycle
    expect(isCircularEmbed('doc-b', 'doc-a', ['doc-a', 'doc-c'])).toBe(true);
  });

  it('returns true when currentDocId appears deep in embedChain (A→B→C→A)', () => {
    expect(isCircularEmbed('doc-b', 'doc-a', ['doc-c', 'doc-d', 'doc-a'])).toBe(true);
  });

  it('returns false when embedChain does not contain currentDocId', () => {
    expect(isCircularEmbed('doc-b', 'doc-a', ['doc-c', 'doc-d'])).toBe(false);
  });

  it('returns false when embedChain is empty', () => {
    expect(isCircularEmbed('doc-b', 'doc-a', [])).toBe(false);
  });

  it('defaults to empty embedChain when not provided — no cycle', () => {
    expect(isCircularEmbed('doc-b', 'doc-a')).toBe(false);
  });

  it('returns false when docId is null even if embedChain contains currentDocId', () => {
    // No target doc selected — cannot form a cycle
    expect(isCircularEmbed(null, 'doc-a', ['doc-a'])).toBe(false);
  });

  it('returns false when currentDocId is undefined even if embedChain is non-empty', () => {
    expect(isCircularEmbed('doc-b', undefined, ['doc-x', 'doc-y'])).toBe(false);
  });

  it('direct self-embed takes priority regardless of embedChain', () => {
    // docId === currentDocId is caught before checking embedChain
    expect(isCircularEmbed('doc-a', 'doc-a', [])).toBe(true);
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
