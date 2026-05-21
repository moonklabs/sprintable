import TurndownService from 'turndown';

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});

// Disable Turndown's built-in text escape function.
// We do round-trip editing (WYSIWYG ↔ markdown), so auto-escaping
// causes backslash accumulation on every load/save cycle:
//   "hello_world" → "hello\_world" → "hello\\_world" → …
// TipTap handles structural formatting; no inline text escaping is needed.
(turndown as unknown as { escape: (str: string) => string }).escape = (str: string) => str;

// TaskList item rule — converts Tiptap taskItem nodes to GFM task list syntax (- [x] / - [ ])
// Must be registered before the generic compactListItem rule so it wins for taskItem elements.
turndown.addRule('taskListItem', {
  filter: (node) =>
    node.nodeName === 'LI' &&
    (node as HTMLElement).getAttribute('data-type') === 'taskItem',
  replacement: (content, node) => {
    const checked = (node as HTMLElement).getAttribute('data-checked') === 'true';
    const clean = content.replace(/^\n+/, '').replace(/\n\s*\n/g, '\n').trimEnd();
    return `- [${checked ? 'x' : ' '}] ${clean}\n`;
  },
});

// Custom list item rule — produces compact format regardless of whether
// TipTap wrapped the content in <p> tags (which it always does via schema normalization).
// Without this, Turndown outputs "loose" lists with blank lines between items:
//   -   item\n    \n-   next  →  fixed to:  - item\n- next
turndown.addRule('compactListItem', {
  filter: 'li',
  replacement: (content, node) => {
    const clean = content
      .replace(/^\n+/, '')       // strip leading newlines from <p>
      .replace(/\n\s*\n/g, '\n') // collapse blank lines
      .trimEnd();
    const isOrdered = (node as HTMLElement).parentElement?.nodeName === 'OL';
    if (isOrdered) {
      const siblings = Array.from((node as HTMLElement).parentElement?.children ?? []);
      const index = siblings.indexOf(node as HTMLElement) + 1;
      return `${index}. ${clean}\n`;
    }
    return `- ${clean}\n`;
  },
});

// Preserve toggle blocks as raw HTML — must be before generic block rules
turndown.addRule('toggleBlock', {
  filter: (node) =>
    node.nodeName === 'DIV' &&
    (node as HTMLElement).getAttribute('data-type') === 'toggleBlock',
  replacement: (_content, node) => {
    const el = node as HTMLElement;
    const isOpen = el.getAttribute('data-open') === 'true';
    const summaryEl = el.querySelector('[data-type="toggleSummary"]');
    const contentEl = el.querySelector('[data-type="toggleContent"]');
    const summaryHtml = summaryEl ? summaryEl.innerHTML : '';
    const contentHtml = contentEl ? contentEl.innerHTML : '';
    return `\n<div data-type="toggleBlock" data-open="${isOpen}"><div data-type="toggleSummary">${summaryHtml}</div><div data-type="toggleContent">${contentHtml}</div></div>\n`;
  },
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
export function markdownToHtml(rawMd: string): string {
  if (!rawMd.trim()) return '';

  // Strip accumulated Turndown backslash escapes from previously saved content.
  // Turndown added these automatically on prior saves; each round-trip doubled them.
  // Process ordered-list dots first (may have multiple backslashes), then inline escapes.
  const md = rawMd
    .replace(/^(\d+)\\+\. /gm, '$1. ')
    .replace(/\\([*_`[\]\\])/g, '$1');

  // Extract fenced code blocks first to prevent other transforms from modifying their content.
  // Subsequent regex passes use gm flags which would otherwise corrupt multi-line code blocks.
  const codeBlockPlaceholders: string[] = [];
  let html = md.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    const idx = codeBlockPlaceholders.length;
    const langAttrs = lang ? ` data-language="${lang}" class="language-${lang}"` : '';
    const codeClass = lang ? ` class="language-${lang}"` : '';
    codeBlockPlaceholders.push(`<pre${langAttrs}><code${codeClass}>${escapeHtml(code.trimEnd())}</code></pre>`);
    return `\x00CODEBLOCK${idx}\x00`;
  });

  // Protect page-embed and toggle atoms — written as raw HTML by htmlToMarkdown()
  // and must survive the HTML-escape pass below intact.
  const atomPlaceholders: string[] = [];
  html = html.replace(/<div\s+data-page-embed[^>]*><\/div>/g, (m) => {
    const idx = atomPlaceholders.length;
    atomPlaceholders.push(m);
    return `\x00ATOM${idx}\x00`;
  });
  // Toggle blocks are stored as single-line raw HTML by the Turndown rule above
  html = html.replace(/^<div data-type="toggleBlock"[^\n]*<\/div>$/gm, (m) => {
    const idx = atomPlaceholders.length;
    atomPlaceholders.push(m);
    return `\x00ATOM${idx}\x00`;
  });

  // Escape raw HTML in non-codeblock, non-atom regions so user-typed tags like
  // <bold> or <div> don't get parsed as real HTML elements by the browser.
  // '>' is intentionally excluded to preserve blockquote markers (^> pattern below).
  html = html.split(/(\x00CODEBLOCK\d+\x00|\x00ATOM\d+\x00)/g).map((seg, i) =>
    i % 2 === 1 ? seg : seg.replace(/&/g, '&amp;').replace(/</g, '&lt;'),
  ).join('');

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

  // Links — sanitize javascript: hrefs
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text, href) => {
    const safeHref = /^javascript:/i.test(href.trim()) ? '#' : href;
    return `<a href="${safeHref}">${text}</a>`;
  });

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

  // Ordered lists — also handle Turndown-escaped "1\. " notation from existing DB data
  html = html.replace(/(?:^\d+\\?\.\s+.+(?:\n|$))+/gm, (listBlock) => {
    const items = listBlock
      .trim()
      .split('\n')
      .map((line) => line.replace(/^\d+\\?\.\s+/, '').trim())
      .filter(Boolean);

    if (items.length === 0) {
      return listBlock;
    }

    return `<ol>${items.map((item) => `<li><p>${item}</p></li>`).join('')}</ol>`;
  });

  // Task lists (GFM: - [ ] / - [x]) — must be before unordered list rule
  html = html.replace(/(?:^-\s+\[[ x]\]\s+.+(?:\n|$))+/gm, (listBlock) => {
    const items = listBlock.trim().split('\n').filter(Boolean);
    const listItems = items.map((line) => {
      const match = line.match(/^-\s+\[([ x])\]\s+(.+)$/);
      if (!match) return '';
      const checked = match[1] === 'x';
      const text = match[2] ?? '';
      return `<li data-type="taskItem" data-checked="${checked}"><label><input type="checkbox"${checked ? ' checked' : ''}></label><div><p>${text}</p></div></li>`;
    }).filter(Boolean).join('');
    return `<ul data-type="taskList">${listItems}</ul>`;
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

    return `<ul>${items.map((item) => `<li><p>${item}</p></li>`).join('')}</ul>`;
  });

  // Paragraphs - wrap remaining plain-text lines (exclude HTML tags and code block/atom placeholders)
  html = html.replace(/^(?!<[a-z/])(?!\x00CODEBLOCK)(?!\x00ATOM)(.*\S.*)$/gm, '<p>$1</p>');

  // Clean up extra whitespace
  html = html.replace(/\n{3,}/g, '\n\n');

  // Restore page-embed atoms before code blocks (order matters — CODEBLOCK restore must be last)
  html = html.replace(/\x00ATOM(\d+)\x00/g, (_, i) => atomPlaceholders[Number(i)] ?? '');

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

const ESCAPED_PIPE = '\x01PIPE\x01';

function parseTableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  if (!trimmed) return [];

  // Replace escaped pipes (\|) with a placeholder before splitting,
  // then restore them in each cell so they render as literal '|'.
  return trimmed
    .replace(/\\\|/g, ESCAPED_PIPE)
    .split('|')
    .map((cell) => cell.trim().replace(new RegExp(ESCAPED_PIPE, 'g'), '|'));
}
