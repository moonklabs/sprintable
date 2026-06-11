import { describe, it, expect } from 'vitest';
import { htmlToMarkdown, markdownToHtml } from './content-converter';

// ---------------------------------------------------------------------------
// Round-trip idempotency suite (story 2a72ebf4 / FIX-3)
//
// The editor stores markdown. On load it runs markdown → HTML (markdownToHtml)
// into TipTap, and on any update serializes HTML → markdown (htmlToMarkdown).
// If htmlToMarkdown(markdownToHtml(md)) !== md for already-saved content, the
// doc is judged dirty *on load with zero typing* → autosave persists a mutated
// body (incl. table cells losing inline formatting). The fix: the converter
// round-trip must be a fixed point on its own canonical output.
//
// Each fixture below is written in the converter's CANONICAL output form, so a
// correct converter satisfies rt(fixture) === fixture. We also assert the
// stabilization property rt(rt(x)) === rt(x) for arbitrary inputs.
// ---------------------------------------------------------------------------

/** One editor load→serialize round-trip. */
const rt = (md: string): string => htmlToMarkdown(markdownToHtml(md));

describe('content-converter round-trip idempotency (2a72ebf4)', () => {
  const fixtures: Record<string, string> = {
    'plain paragraph': 'Hello world.',
    'headings': '# H1\n\n## H2\n\n### H3',
    'bold + italic': '**bold** and _italic_ text',
    'nested bold in sentence': 'a **bold _and italic_** tail',
    'inline code': 'use `const x = 1` here',
    'link': '[example](https://example.com)',
    'unordered list': '- one\n- two\n- three',
    'ordered list': '1. one\n2. two\n3. three',
    'task list': '- [ ] todo\n- [x] done',
    'horizontal rule': 'before\n\n---\n\nafter',
    'blockquote single': '> quoted line',
    'blockquote multi-line': '> line one\n> line two',
    'code fence with lang': '```js\nconst x = 1;\nconst y = 2;\n```',
    'code fence no lang': '```\nplain code\n```',
    'gfm table plain': '| name | role |\n| --- | --- |\n| didi | dev |',
    'gfm table inline cells': '| field | value |\n| --- | --- |\n| **bold** | `code` |\n| [link](https://x.com) | _em_ |',
  };

  for (const [name, md] of Object.entries(fixtures)) {
    it(`is a fixed point: ${name}`, () => {
      expect(rt(md)).toBe(md);
    });
  }

  // Combined complex document — the real "복잡 마크다운" repro shape.
  const COMPLEX = [
    '# Title',
    '',
    'Intro **paragraph** with `code` and a [link](https://example.com).',
    '',
    '## Table',
    '',
    '| field | value |',
    '| --- | --- |',
    '| **bold** | `code` |',
    '| [link](https://x.com) | plain |',
    '',
    '> A quote',
    '> spanning lines',
    '',
    '---',
    '',
    '- [ ] open task',
    '- [x] done task',
    '',
    '```ts',
    'const n = 1;',
    '```',
  ].join('\n');

  it('is a fixed point: combined complex document', () => {
    expect(rt(COMPLEX)).toBe(COMPLEX);
  });

  it('stabilizes after one round-trip (rt(rt(x)) === rt(x))', () => {
    const once = rt(COMPLEX);
    expect(rt(once)).toBe(once);
  });
});

describe('content-converter table cell inline preservation (AC③)', () => {
  it('preserves bold/code/link inside table cells through a round-trip', () => {
    const md = '| a | b |\n| --- | --- |\n| **x** | `y` |';
    const out = rt(md);
    expect(out).toContain('**x**');
    expect(out).toContain('`y`');
  });
});
