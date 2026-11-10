// story 4892 (UI-9 D1) — the wiki-link node view's no-router fallback also opens the target to READ. The node view cannot be rendered without the whole editor, so this pins
// the one source line (the router path is covered in the editor page test: `onNavigate` → /view).
import { describe, expect, it } from 'vitest';
import source from './wiki-link.tsx?raw';

describe('wiki-link node view fallback (4892)', () => {
  it('the flat fallback ends in /view, not the editor route', () => {
    expect(source).toContain('flatHref(`/docs/${slug}/view`)');
    expect(source).not.toContain('flatHref(`/docs/${slug}`)');
  });
});
