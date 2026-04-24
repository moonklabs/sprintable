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

  it('renders escaped pipe inside table cell as literal |', () => {
    const result = markdownToHtml('| expr | value |\n| --- | --- |\n| a \\| b | 1 |');
    expect(result).toContain('<table>');
    expect(result).toContain('a | b');
    // should not create an extra column for the escaped pipe
    const cellMatches = result.match(/<td>/g) ?? [];
    expect(cellMatches.length).toBe(2);
  });

  it('escapes raw HTML open-tags outside code blocks', () => {
    const result = markdownToHtml('<bold>text</bold> and **md**');
    // '<' is escaped so no live <bold> element; '>' preserved for blockquote compat
    expect(result).not.toContain('<bold>');
    expect(result).toContain('&lt;bold>');
    expect(result).toContain('<strong>md</strong>');
  });

  it('does not escape html inside fenced code blocks', () => {
    const result = markdownToHtml('```\n<div>raw</div>\n```');
    // code blocks use escapeHtml so < becomes &lt; but is inside <pre><code>
    expect(result).toContain('<pre><code>');
    expect(result).not.toContain('<div>raw</div>');
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

  it('preserves page-embed atoms through html escape pass', () => {
    const embed = '<div data-page-embed data-doc-id="abc" data-title="Doc" data-icon="" data-slug="doc"></div>';
    const md = `\n${embed}\n`;
    const result = markdownToHtml(md);
    expect(result).toContain('data-page-embed');
    expect(result).toContain('data-doc-id="abc"');
    expect(result).not.toContain('&lt;div');
  });

  it('neutralizes XSS in heading text (E-MINOR-BUGS regression guard)', () => {
    const result = markdownToHtml('# <script>alert("xss")</script>Title');
    expect(result).not.toContain('<script>');
    expect(result).toContain('&lt;script>');
  });

  it('neutralizes XSS in inline content', () => {
    const result = markdownToHtml('Hello <img src=x onerror=alert(1)> world');
    expect(result).not.toContain('<img src=x');
    expect(result).toContain('&lt;img');
  });

  it('neutralizes javascript: href in links', () => {
    const result = markdownToHtml('[click](javascript:alert(1))');
    expect(result).not.toContain('javascript:alert');
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
