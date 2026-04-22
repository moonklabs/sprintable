import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// DOMPurify runs only in browser environments. Mock it as an identity function so
// the server-side heading sanitisation logic (attrs removal + sanitizeHeadingInner)
// is exercised without needing a real DOM.
vi.mock('dompurify', () => ({
  default: { sanitize: (html: string) => html },
}));

import { DocContentRenderer } from './doc-content-renderer';

describe('DocContentRenderer', () => {
  it('renders raw html embedded in markdown instead of exposing escaped tags', () => {
    const markup = renderToStaticMarkup(
      <DocContentRenderer content={'<h2>제목</h2>\n\n본문'} contentFormat="markdown" />,
    );

    expect(markup).toContain('<h2 id="제목">제목</h2>');
    expect(markup).toContain('<p>본문</p>');
    expect(markup).not.toContain('&lt;h2&gt;');
  });

  it('adds stable heading anchors and copy actions for markdown docs', () => {
    const markup = renderToStaticMarkup(
      <DocContentRenderer
        content={'# Overview\n\n<h2>HTML Heading In Markdown</h2>\n\n```ts\nconst answer = 42;\n```\n\n| col | val |\n| --- | --- |\n| a | b |'}
        contentFormat="markdown"
        codeCopyLabel="Copy code"
      />,
    );

    expect(markup).toContain('<h1 id="overview">Overview</h1>');
    expect(markup).toContain('<h2 id="html-heading-in-markdown">HTML Heading In Markdown</h2>');
    expect(markup).toContain('data-doc-copy-button="true"');
    expect(markup).toContain('Copy code');
    expect(markup).toContain('<table>');
  });

  it('decorates html docs with heading anchors, table shells, and copy actions', () => {
    const markup = renderToStaticMarkup(
      <DocContentRenderer
        content={'<h1>HTML Title</h1><table><thead><tr><th>A</th></tr></thead><tbody><tr><td>B</td></tr></tbody></table><pre><code>SELECT 1;</code></pre>'}
        contentFormat="html"
        codeCopyLabel="Copy"
      />,
    );

    expect(markup).toContain('<h1 id="html-title">HTML Title</h1>');
    expect(markup).toContain('data-doc-copy-button="true"');
    expect(markup).toContain('overflow-x-auto');
    expect(markup).toContain('SELECT 1;');
  });

  it('sanitizes dangerous heading attributes and inner tags', () => {
    const markup = renderToStaticMarkup(
      <DocContentRenderer
        content={'<h1 onclick="alert(1)">제목</h1><h2><img src=x onerror="alert(2)"><strong>ok</strong></h2>'}
        contentFormat="html"
      />,
    );

    // heading element itself must not carry event-handler attributes
    expect(markup).not.toContain(' onclick=');
    // dangerous inner tags must be escaped — no live <img> element in output
    expect(markup).not.toContain('<img ');
    // safe inline tags inside heading inner are preserved by sanitizeHeadingInner
    expect(markup).toContain('<strong>ok</strong>');
  });
});
