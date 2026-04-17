export interface DocHeading {
  id: string;
  text: string;
  level: 1 | 2 | 3;
}

export function slugifyHeading(text: string): string {
  const slug = text
    .replace(/<[^>]+>/g, ' ')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');

  return slug || 'section';
}

export function extractDocHeadings(
  content: string,
  contentFormat: 'markdown' | 'html' = 'markdown',
): DocHeading[] {
  if (!content.trim()) return [];

  const headings = contentFormat === 'html'
    ? extractHtmlHeadings(content)
    : extractMarkdownHeadings(content);

  const counts = new Map<string, number>();

  return headings.map((heading) => {
    const baseId = slugifyHeading(heading.text);
    const seen = counts.get(baseId) ?? 0;
    counts.set(baseId, seen + 1);

    return {
      ...heading,
      id: seen === 0 ? baseId : `${baseId}-${seen + 1}`,
    };
  });
}

function extractMarkdownHeadings(content: string): Array<Omit<DocHeading, 'id'>> {
  const visibleContent = stripFencedCodeBlocks(content);
  const tokenRegex = /^(#{1,3})\s+(.+)$|<h([1-3])[^>]*>([\s\S]*?)<\/h\3>/gim;

  return Array.from(visibleContent.matchAll(tokenRegex))
    .map((match) => {
      if (match[1]) {
        const level = match[1].length as 1 | 2 | 3;
        const text = normalizeHeadingText(match[2]);
        if (!text) return null;
        return { level, text };
      }

      if (match[3]) {
        const level = Number(match[3]) as 1 | 2 | 3;
        const text = normalizeHeadingText(match[4]);
        if (!text) return null;
        return { level, text };
      }

      return null;
    })
    .filter((heading): heading is Omit<DocHeading, 'id'> => Boolean(heading));
}

function stripFencedCodeBlocks(content: string): string {
  const lines = content.split(/\r?\n/);
  const visibleLines: string[] = [];
  let inFence = false;

  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      inFence = !inFence;
      continue;
    }

    if (!inFence) {
      visibleLines.push(line);
    }
  }

  return visibleLines.join('\n');
}

function extractHtmlHeadings(content: string): Array<Omit<DocHeading, 'id'>> {
  if (typeof DOMParser !== 'undefined') {
    const parser = new DOMParser();
    const doc = parser.parseFromString(content, 'text/html');

    return Array.from(doc.querySelectorAll('h1, h2, h3'))
      .map((heading) => {
        const level = Number(heading.tagName.slice(1)) as 1 | 2 | 3;
        const text = normalizeHeadingText(heading.textContent ?? '');
        if (!text) return null;
        return { level, text };
      })
      .filter((heading): heading is Omit<DocHeading, 'id'> => Boolean(heading));
  }

  const matches = Array.from(content.matchAll(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi));
  return matches
    .map((match) => {
      const level = Number(match[1]) as 1 | 2 | 3;
      const text = normalizeHeadingText(match[2]);
      if (!text) return null;
      return { level, text };
    })
    .filter((heading): heading is Omit<DocHeading, 'id'> => Boolean(heading));
}

function normalizeHeadingText(text: string): string {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[*_~>#]/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}
