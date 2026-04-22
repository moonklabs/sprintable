import TurndownService from 'turndown';

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});

// Preserve page-embed atoms — must be before the generic block rule
turndown.addRule('pageEmbed', {
  filter: (node) => node.nodeName === 'DIV' && node.hasAttribute('data-page-embed'),
  replacement: (_content, node) => {
    const el = node as HTMLElement;
    const docId = el.getAttribute('data-doc-id') ?? '';
    const title = el.getAttribute('data-title') ?? '';
    const icon = el.getAttribute('data-icon') ?? '';
    const slug = el.getAttribute('data-slug') ?? '';
    return `\n<div data-page-embed data-doc-id="${docId}" data-title="${title}" data-icon="${icon}" data-slug="${slug}"></div>\n`;
  },
});

// Preserve callout divs
turndown.addRule('callout', {
  filter: (node) =>
    node.nodeName === 'DIV' &&
    (node.hasAttribute('data-callout') || node.classList.contains('callout')),
  replacement: (content) => `\n> 💡 ${content.trim()}\n`,
});

// Preserve table structure
turndown.addRule('tableCell', {
  filter: ['th', 'td'],
  replacement: (content) => ` ${content.trim()} |`,
});
turndown.addRule('tableRow', {
  filter: 'tr',
  replacement: (content) => `|${content}\n`,
});
turndown.addRule('tableHead', {
  filter: 'thead',
  replacement: (content) => {
    const cols = (content.match(/\|/g)?.length ?? 1) - 1;
    const separator = `|${Array(cols).fill(' --- ').join('|')}|\n`;
    return `${content}${separator}`;
  },
});
turndown.addRule('table', {
  filter: 'table',
  replacement: (_content, node) => {
    const table = node as HTMLTableElement;
    const rows: string[] = [];
    Array.from(table.querySelectorAll('tr')).forEach((tr, i) => {
      const cells = Array.from(tr.querySelectorAll('th, td')).map((cell) => cell.textContent?.trim() ?? '');
      rows.push(`| ${cells.join(' | ')} |`);
      if (i === 0) {
        rows.push(`| ${cells.map(() => '---').join(' | ')} |`);
      }
    });
    return `\n${rows.join('\n')}\n`;
  },
});

/**
 * Convert HTML to markdown. Used when saving markdown-format docs
 * that were edited in the rich editor.
 */
export function htmlToMarkdown(html: string): string {
  if (!html.trim()) return '';
  return turndown.turndown(html).trim();
}

/**
 * Convert markdown to HTML for loading into TipTap.
 * Uses a minimal approach - TipTap's StarterKit handles most markdown
 * when loaded as HTML via DOMParser, so we handle the basic cases.
 */
export function markdownToHtml(md: string): string {
  if (!md.trim()) return '';

  // Extract fenced code blocks first to prevent other transforms from modifying their content.
  // Subsequent regex passes use gm flags which would otherwise corrupt multi-line code blocks.
  const codeBlockPlaceholders: string[] = [];
  let html = md.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) => {
    const idx = codeBlockPlaceholders.length;
    codeBlockPlaceholders.push(`<pre><code>${escapeHtml(code.trimEnd())}</code></pre>`);
    return `\x00CODEBLOCK${idx}\x00`;
  });

  // Headings
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Horizontal rule
  html = html.replace(/^---$/gm, '<hr>');

  // Blockquotes (including callout pattern)
  html = html.replace(/^> 💡 (.+)$/gm, '<div data-callout class="callout">$1</div>');
  html = html.replace(/^> (.+)$/gm, '<blockquote><p>$1</p></blockquote>');

  // Bold and italic
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Images (before links — both use []() syntax)
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">');

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // GFM tables
  html = html.replace(/(?:^\|.*\|\s*$\n?){2,}/gm, (tableBlock) => {
    const lines = tableBlock
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length < 2 || !isTableSeparatorLine(lines[1])) {
      return tableBlock;
    }

    const headerCells = parseTableCells(lines[0]);
    const bodyRows = lines.slice(2).map(parseTableCells).filter((cells) => cells.length > 0);

    if (headerCells.length === 0) {
      return tableBlock;
    }

    const thead = `<thead><tr>${headerCells.map((cell) => `<th>${cell}</th>`).join('')}</tr></thead>`;
    const tbody = bodyRows.length
      ? `<tbody>${bodyRows
          .map((cells) => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`)
          .join('')}</tbody>`
      : '';

    return `<table>${thead}${tbody}</table>`;
  });

  // Ordered lists
  html = html.replace(/(?:^\d+\.\s+.+(?:\n|$))+/gm, (listBlock) => {
    const items = listBlock
      .trim()
      .split('\n')
      .map((line) => line.replace(/^\d+\.\s+/, '').trim())
      .filter(Boolean);

    if (items.length === 0) {
      return listBlock;
    }

    return `<ol>${items.map((item) => `<li>${item}</li>`).join('')}</ol>`;
  });

  // Unordered lists
  html = html.replace(/(?:^-\s+.+(?:\n|$))+/gm, (listBlock) => {
    const items = listBlock
      .trim()
      .split('\n')
      .map((line) => line.replace(/^-\s+/, '').trim())
      .filter(Boolean);

    if (items.length === 0) {
      return listBlock;
    }

    return `<ul>${items.map((item) => `<li>${item}</li>`).join('')}</ul>`;
  });

  // Paragraphs - wrap remaining plain-text lines (exclude HTML tags and code block placeholders)
  html = html.replace(/^(?!<[a-z/])(?!\x00CODEBLOCK)(.*\S.*)$/gm, '<p>$1</p>');

  // Clean up extra whitespace
  html = html.replace(/\n{3,}/g, '\n\n');

  // Restore fenced code blocks (must be last to avoid double-processing)
  html = html.replace(/\x00CODEBLOCK(\d+)\x00/g, (_, i) => codeBlockPlaceholders[Number(i)] ?? '');

  return html.trim();
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function isTableSeparatorLine(line: string): boolean {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  if (!trimmed) return false;

  return trimmed
    .split('|')
    .every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function parseTableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  if (!trimmed) return [];

  return trimmed.split('|').map((cell) => cell.trim());
}
