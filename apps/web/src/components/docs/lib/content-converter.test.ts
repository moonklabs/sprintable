import { describe, it, expect } from 'vitest';
import { htmlToMarkdown, markdownToHtml } from './content-converter';

describe('markdownToHtml', () => {
  it('converts headings', () => {
    expect(markdownToHtml('# Title')).toContain('<h1>Title</h1>');
    expect(markdownToHtml('## Sub')).toContain('<h2>Sub</h2>');
    expect(markdownToHtml('### Third')).toContain('<h3>Third</h3>');
  });

  it('converts bold and italic', () => {
    expect(markdownToHtml('**bold**')).toContain('<strong>bold</strong>');
    expect(markdownToHtml('*italic*')).toContain('<em>italic</em>');
  });

  it('converts links', () => {
    const result = markdownToHtml('[test](https://example.com)');
    expect(result).toContain('<a href="https://example.com">test</a>');
  });

  it('converts images', () => {
    const result = markdownToHtml('![alt](https://img.png)');
    expect(result).toContain('<img src="https://img.png" alt="alt">');
  });

  it('converts markdown tables into html tables', () => {
    const result = markdownToHtml('| name | role |\n| --- | --- |\n| didi | dev |');
    expect(result).toContain('<table>');
    expect(result).toContain('<th>name</th>');
    expect(result).toContain('<td>didi</td>');
  });

  it('converts ordered lists into ol blocks', () => {
    const result = markdownToHtml('1. one\n2. two');
    expect(result).toContain('<ol>');
    expect(result).toContain('<li>one</li>');
    expect(result).toContain('<li>two</li>');
  });

  it('converts blockquotes', () => {
    expect(markdownToHtml('> quoted')).toContain('<blockquote>');
  });

  it('converts callout blockquotes', () => {
    const result = markdownToHtml('> 💡 callout text');
    expect(result).toContain('data-callout');
    expect(result).toContain('callout text');
  });

  it('converts code blocks', () => {
    const result = markdownToHtml('```js\nconst x = 1;\n```');
    expect(result).toContain('<pre><code>');
    expect(result).toContain('const x = 1;');
  });

  it('converts horizontal rules', () => {
    expect(markdownToHtml('---')).toContain('<hr>');
  });

  it('returns empty string for empty input', () => {
    expect(markdownToHtml('')).toBe('');
    expect(markdownToHtml('   ')).toBe('');
  });
});

describe('htmlToMarkdown', () => {
  it('converts headings', () => {
    expect(htmlToMarkdown('<h1>Title</h1>')).toBe('# Title');
    expect(htmlToMarkdown('<h2>Sub</h2>')).toBe('## Sub');
  });

  it('converts bold and italic', () => {
    expect(htmlToMarkdown('<strong>bold</strong>')).toBe('**bold**');
    expect(htmlToMarkdown('<em>italic</em>')).toBe('_italic_');
  });

  it('converts links', () => {
    expect(htmlToMarkdown('<a href="https://example.com">test</a>')).toBe(
      '[test](https://example.com)',
    );
  });

  it('converts blockquotes', () => {
    const result = htmlToMarkdown('<blockquote><p>quoted</p></blockquote>');
    expect(result).toContain('> quoted');
  });

  it('preserves ordered lists through roundtrip conversion', () => {
    const markdown = '1. one\n2. two';
    expect(htmlToMarkdown(markdownToHtml(markdown))).toContain('1.  one');
    expect(htmlToMarkdown(markdownToHtml(markdown))).toContain('2.  two');
  });

  it('preserves markdown tables through roundtrip conversion', () => {
    const markdown = '| name | role |\n| --- | --- |\n| didi | dev |';
    const result = htmlToMarkdown(markdownToHtml(markdown));
    expect(result).toContain('| name | role |');
    expect(result).toContain('| didi | dev |');
  });

  it('returns empty string for empty input', () => {
    expect(htmlToMarkdown('')).toBe('');
    expect(htmlToMarkdown('   ')).toBe('');
  });
});
