import { describe, expect, it } from 'vitest';
import { extractDocHeadings, slugifyHeading } from './doc-heading-utils';

describe('doc-heading-utils', () => {
  it('extracts markdown headings with stable unique ids', () => {
    expect(extractDocHeadings([
      '# Overview',
      'body',
      '## 세부 항목',
      '# Overview',
      '```ts',
      '# ignored inside code fence',
      '```',
    ].join('\n'))).toEqual([
      { id: 'overview', level: 1, text: 'Overview' },
      { id: '세부-항목', level: 2, text: '세부 항목' },
      { id: 'overview-2', level: 1, text: 'Overview' },
    ]);
  });

  it('extracts html headings in document order', () => {
    expect(extractDocHeadings(
      '<h1>Docs Home</h1><p>x</p><h2>API &amp; Sync</h2><h3><code>copy()</code> action</h3>',
      'html',
    )).toEqual([
      { id: 'docs-home', level: 1, text: 'Docs Home' },
      { id: 'api-sync', level: 2, text: 'API & Sync' },
      { id: 'copy-action', level: 3, text: 'copy() action' },
    ]);
  });

  it('extracts raw html headings embedded in markdown in document order', () => {
    expect(extractDocHeadings([
      '# Markdown Intro',
      '',
      '<h2>HTML Heading In Markdown</h2>',
      '',
      '### Markdown Tail',
      '```html',
      '<h1>ignored in fence</h1>',
      '```',
    ].join('\n'), 'markdown')).toEqual([
      { id: 'markdown-intro', level: 1, text: 'Markdown Intro' },
      { id: 'html-heading-in-markdown', level: 2, text: 'HTML Heading In Markdown' },
      { id: 'markdown-tail', level: 3, text: 'Markdown Tail' },
    ]);
  });

  it('slugifies mixed unicode headings', () => {
    expect(slugifyHeading('  모바일 TOC / 코드 복사  ')).toBe('모바일-toc-코드-복사');
  });
});
