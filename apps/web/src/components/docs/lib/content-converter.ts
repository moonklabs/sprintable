import TurndownService from 'turndown';

// fileAttachment 노드는 내용 없는 <div>(non-void) → turndown 의 blank 처리에 의해 drop 된다
// (이미지는 <img> 가 void 라 살아남음). blankReplacement 에서 fileAttachment 만 특별 처리해 보존.
function serializeFileAttachment(el: HTMLElement): string {
  const safeAttr = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const filename = safeAttr(el.getAttribute('data-filename') ?? '');
  const size = safeAttr(el.getAttribute('data-size') ?? '0');
  const mimeType = safeAttr(el.getAttribute('data-mime-type') ?? '');
  const assetId = el.getAttribute('data-asset-id');
  // S4: ref(assetId) → data-asset-id(data-file-data 부재) · legacy → data-file-data. 상호배타(renderHTML 정합).
  const tail = assetId
    ? ` data-asset-id="${safeAttr(assetId)}"`
    : ` data-file-data="${el.getAttribute('data-file-data') ?? ''}"`;
  return `\n<div data-type="fileAttachment" data-filename="${filename}" data-size="${size}" data-mime-type="${mimeType}"${tail}></div>\n`;
}

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  // 내용-없는 fileAttachment <div> 가 blank 로 drop 되지 않도록 raw HTML 로 보존(legacy·ref 공통).
  blankReplacement: (_content: string, node: unknown) => {
    const el = node as HTMLElement & { isBlock?: boolean };
    if (el && typeof el.getAttribute === 'function' && el.getAttribute('data-type') === 'fileAttachment') {
      return serializeFileAttachment(el);
    }
    return el?.isBlock ? '\n\n' : '';
  },
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
// Excludes taskItem LIs explicitly: Turndown 7.x resolves rules most-recently-added-first,
// so this generic rule would otherwise shadow taskListItem above and drop the `- [ ]` marker
// (round-trip non-idempotency → dirty-on-load, story 2a72ebf4).
turndown.addRule('compactListItem', {
  filter: (node) =>
    node.nodeName === 'LI' &&
    (node as HTMLElement).getAttribute('data-type') !== 'taskItem',
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

// Preserve image width — Turndown strips style from <img>; serialize as raw HTML for round-trip
turndown.addRule('imageWithWidth', {
  filter: (node) =>
    node.nodeName === 'IMG' && !!(node as HTMLElement).style.width,
  replacement: (_content, node) => {
    const el = node as HTMLImageElement;
    const src = el.getAttribute('src') ?? '';
    const alt = el.getAttribute('alt') ?? '';
    const width = el.style.width;
    return `\n<img src="${src}" alt="${alt}" style="width:${width};max-width:100%;height:auto">\n`;
  },
});

// Preserve wiki link inline nodes as raw HTML
turndown.addRule('wikiLink', {
  filter: (node) =>
    node.nodeName === 'SPAN' &&
    (node as HTMLElement).getAttribute('data-type') === 'wikiLink',
  replacement: (_content, node) => {
    const el = node as HTMLElement;
    const safeAttr = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const docId = safeAttr(el.getAttribute('data-doc-id') ?? '');
    const title = safeAttr(el.getAttribute('data-title') ?? el.textContent ?? '');
    const slug = safeAttr(el.getAttribute('data-slug') ?? '');
    return `<span data-type="wikiLink" data-doc-id="${docId}" data-title="${title}" data-slug="${slug}">${title}</span>`;
  },
});

// Preserve columns block as raw HTML
turndown.addRule('columnsBlock', {
  filter: (node) =>
    node.nodeName === 'DIV' &&
    (node as HTMLElement).getAttribute('data-type') === 'columnsBlock',
  replacement: (_content, node) => {
    const el = node as HTMLElement;
    const cols = el.getAttribute('data-cols') ?? '2';
    const columnsHtml = Array.from(el.querySelectorAll('[data-type="columnBlock"]'))
      .map((col) => `<div data-type="columnBlock">${(col as HTMLElement).innerHTML}</div>`)
      .join('');
    return `\n<div data-type="columnsBlock" data-cols="${cols}">${columnsHtml}</div>\n`;
  },
});

// Preserve math block nodes as raw HTML
turndown.addRule('mathBlock', {
  filter: (node) =>
    node.nodeName === 'DIV' &&
    (node as HTMLElement).getAttribute('data-type') === 'mathBlock',
  replacement: (_content, node) => {
    const el = node as HTMLElement;
    const latex = el.textContent ?? '';
    const safeAttr = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `\n<div data-type="mathBlock" data-latex="${safeAttr(latex)}">${safeAttr(latex)}</div>\n`;
  },
});

// Preserve math inline nodes as raw HTML
turndown.addRule('mathInline', {
  filter: (node) =>
    node.nodeName === 'SPAN' &&
    (node as HTMLElement).getAttribute('data-type') === 'mathInline',
  replacement: (_content, node) => {
    const el = node as HTMLElement;
    const latex = el.textContent ?? '';
    const safeAttr = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<span data-type="mathInline">${safeAttr(latex)}</span>`;
  },
});

// Preserve embed blocks as raw HTML
turndown.addRule('embedBlock', {
  filter: (node) =>
    node.nodeName === 'DIV' &&
    (node as HTMLElement).getAttribute('data-type') === 'embedBlock',
  replacement: (_content, node) => {
    const el = node as HTMLElement;
    const safeAttr = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const url = safeAttr(el.getAttribute('data-url') ?? '');
    return `\n<div data-type="embedBlock" data-url="${url}"></div>\n`;
  },
});

// Preserve file attachment blocks as raw HTML
turndown.addRule('fileAttachment', {
  filter: (node) =>
    node.nodeName === 'DIV' &&
    (node as HTMLElement).getAttribute('data-type') === 'fileAttachment',
  replacement: (_content, node) => serializeFileAttachment(node as HTMLElement),
});

// S4: asset-ref 이미지(src 없음·data-asset-id) → raw HTML 직렬화(마크다운 ![](.) 로는 ref/메타 손실).
// imageWithWidth 보다 뒤에 등록 → data-asset-id 가진 img 에 우선(turndown 7: 최신 규칙 우선).
turndown.addRule('imageWithAsset', {
  filter: (node) => node.nodeName === 'IMG' && !!(node as HTMLElement).getAttribute('data-asset-id'),
  replacement: (_content, node) => {
    const el = node as HTMLElement;
    const a = (name: string) => {
      const v = el.getAttribute(name);
      return v == null ? '' : ` ${name}="${v.replace(/"/g, '&quot;')}"`;
    };
    const width = el.style.width ? ` style="width:${el.style.width};max-width:100%;height:auto"` : '';
    return `\n<img${a('data-asset-id')}${a('data-filename')}${a('data-size')}${a('data-mime-type')}${a('alt')}${width}>\n`;
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
      const cells = Array.from(tr.querySelectorAll('th, td')).map((cell) => serializeTableCell(cell));
      rows.push(`| ${cells.join(' | ')} |`);
      if (i === 0) {
        rows.push(`| ${cells.map(() => '---').join(' | ')} |`);
      }
    });
    return `\n${rows.join('\n')}\n`;
  },
});

// Serialize a table cell's inline content to markdown — NOT textContent, which
// strips bold/italic/code/link formatting (round-trip data loss, story 2a72ebf4 AC③).
// Re-run Turndown on the cell's inner HTML, then flatten to a single inline cell:
// collapse any newlines to spaces and escape literal pipes so they don't split columns.
function serializeTableCell(cell: Element): string {
  const inner = (cell as HTMLElement).innerHTML;
  return turndown
    .turndown(inner)
    .replace(/\r?\n+/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
}

// Horizontal rule — Turndown's default emits `* * *`, but markdownToHtml only
// recognizes `---` (and that is what users type), so the default broke round-trip
// idempotency (`---` → `<hr>` → `* * *`) → dirty-on-load (story 2a72ebf4).
turndown.addRule('horizontalRule', {
  filter: 'hr',
  replacement: () => '\n---\n',
});

// Blockquote — Turndown's default puts a blank quoted line (`>`) between paragraphs,
// so a multi-line quote serialized to `> a\n>\n> b` instead of the tight `> a\n> b`
// that markdownToHtml round-trips from. Collapse internal blank lines so the round
// trip is idempotent (story 2a72ebf4). The callout rule (data-callout) handles 💡
// blocks separately and is unaffected.
turndown.addRule('blockquote', {
  filter: 'blockquote',
  replacement: (content) => {
    const inner = content.replace(/^\n+|\n+$/g, '').replace(/\n\s*\n/g, '\n');
    return `\n\n${inner.replace(/^/gm, '> ')}\n\n`;
  },
});

// Fenced code block — read the language from whichever element carries it so the
// fence survives the LIVE editor round-trip (story 2a72ebf4 FIX-3b). Turndown's
// default reads only the <code> class; tiptap's getHTML put `language-*` on <pre>
// (not <code>), so ```ts dropped to ``` on load → dirty → unsaveable code-block docs.
// Order: <code> class (markdownToHtml output) → <pre> data-language / class (tiptap
// getHTML + legacy). Belt-and-suspenders with the renderHTML fix in code-block-copy.tsx.
// Find the <code> via element children rather than firstChild so a whitespace text node
// between <pre> and <code> doesn't drop the rule to Turndown's default (review note;
// `children` is used instead of `:scope > code` which domino does not reliably support).
const fenceCodeChild = (pre: HTMLElement): HTMLElement | null =>
  (Array.from(pre.children).find((c) => c.nodeName === 'CODE') as HTMLElement | undefined) ?? null;
turndown.addRule('fencedCodeBlock', {
  filter: (node) =>
    node.nodeName === 'PRE' &&
    !!fenceCodeChild(node as HTMLElement),
  replacement: (_content, node) => {
    const pre = node as HTMLElement;
    const code = fenceCodeChild(pre);
    const langFromClass = (el: HTMLElement | null) => el?.className.match(/language-(\S+)/)?.[1] ?? null;
    const lang =
      langFromClass(code) ??
      pre.getAttribute('data-language') ??
      langFromClass(pre) ??
      '';
    const text = (code?.textContent ?? '').replace(/\n$/, '');
    return `\n\n\`\`\`${lang}\n${text}\n\`\`\`\n\n`;
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
  // Columns blocks — may span multiple lines, protect by start tag
  html = html.replace(/^<div data-type="columnsBlock"[\s\S]*?<\/div>\s*<\/div>$/gm, (m) => {
    const idx = atomPlaceholders.length;
    atomPlaceholders.push(m);
    return `\x00ATOM${idx}\x00`;
  });
  // Math blocks — stored as single-line raw HTML
  html = html.replace(/^<div data-type="mathBlock"[^\n]*<\/div>$/gm, (m) => {
    const idx = atomPlaceholders.length;
    atomPlaceholders.push(m);
    return `\x00ATOM${idx}\x00`;
  });
  // Wiki link spans
  html = html.replace(/<span data-type="wikiLink"[^>]*>[^<]*<\/span>/g, (m) => {
    const idx = atomPlaceholders.length;
    atomPlaceholders.push(m);
    return `\x00ATOM${idx}\x00`;
  });
  // Math inline — protect span tags
  html = html.replace(/<span data-type="mathInline">[^<]*<\/span>/g, (m) => {
    const idx = atomPlaceholders.length;
    atomPlaceholders.push(m);
    return `\x00ATOM${idx}\x00`;
  });
  // Embed blocks — stored as single-line raw HTML
  html = html.replace(/^<div data-type="embedBlock"[^\n]*><\/div>$/gm, (m) => {
    const idx = atomPlaceholders.length;
    atomPlaceholders.push(m);
    return `\x00ATOM${idx}\x00`;
  });
  // File attachment blocks — stored as single-line raw HTML
  html = html.replace(/^<div data-type="fileAttachment"[^\n]*><\/div>$/gm, (m) => {
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
  // Images with width style — serialized as raw HTML by imageWithWidth Turndown rule
  html = html.replace(/^<img\s[^>]*style="width:[^"]*"[^>]*>$/gm, (m) => {
    const idx = atomPlaceholders.length;
    atomPlaceholders.push(m);
    return `\x00ATOM${idx}\x00`;
  });
  // S4: asset-ref images (no src, data-asset-id) — serialized as raw HTML by imageWithAsset rule
  html = html.replace(/^<img\s[^>]*data-asset-id="[^"]*"[^>]*>$/gm, (m) => {
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
  // Merge consecutive '>' lines into ONE blockquote (one <p> per line). Emitting a
  // separate <blockquote> per line round-tripped back with a blank line between them,
  // mutating multi-line quotes on load (story 2a72ebf4). Paired with the blockquote
  // Turndown rule below, which re-joins the paragraphs into tight `> a\n> b`.
  html = html.replace(/(?:^> .+$\n?)+/gm, (block) => {
    const paras = block
      .replace(/\n+$/, '')
      .split('\n')
      .map((line) => `<p>${line.replace(/^> /, '')}</p>`)
      .join('');
    return `<blockquote>${paras}</blockquote>`;
  });

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
