import { describe, expect, it } from 'vitest';
import { getRestoredRevisionDraft, getRevisionContentFormat } from './doc-revision-utils';

describe('doc-revision-utils', () => {
  it('prefers the revision content_format for preview and restore', () => {
    const revision = {
      content: '<p>legacy html</p>',
      content_format: 'html' as const,
    };

    expect(getRevisionContentFormat(revision, 'markdown')).toBe('html');
    expect(getRestoredRevisionDraft(revision, 'markdown')).toEqual({
      content: '<p>legacy html</p>',
      contentFormat: 'html',
    });
  });

  it('falls back to the current document format for legacy revision rows without content_format', () => {
    const revision = {
      content: '# heading',
    };

    expect(getRevisionContentFormat(revision, 'markdown')).toBe('markdown');
    expect(getRestoredRevisionDraft(revision, 'html')).toEqual({
      content: '# heading',
      contentFormat: 'html',
    });
  });
});
