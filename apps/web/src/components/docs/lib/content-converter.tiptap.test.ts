// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { generateJSON, generateHTML } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import { Table } from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { CodeBlockWithCopy } from '../extensions/code-block-copy';
import { htmlToMarkdown, markdownToHtml } from './content-converter';

// ---------------------------------------------------------------------------
// LIVE-path round-trip (story 2a72ebf4 FIX-3b · AC⑦)
//
// The converter-only suite tests htmlToMarkdown(markdownToHtml(md)) directly, which
// CANNOT see what tiptap does to the HTML in between. The real editor load→save path
// is markdownToHtml → tiptap parse (setContent) → tiptap serialize (getHTML) →
// htmlToMarkdown. A regression there (tiptap's CodeBlock emitting the language only on
// <pre>, not <code>) dropped ```ts → ``` on load → dirty → unsaveable code-block docs.
// This layer exercises the real schema parse/serialize so that class of bug fails CI.
// ---------------------------------------------------------------------------

// Same node/mark set the doc editor mounts (sans React node views / suggestion configs,
// which are editor-runtime only and not part of schema serialization).
const extensions = [
  StarterKit.configure({ codeBlock: false }),
  CodeBlockWithCopy,
  Link,
  Table,
  TableRow,
  TableHeader,
  TableCell,
  TaskList,
  TaskItem,
];

/** markdown → tiptap parse → tiptap serialize → markdown (the real editor round-trip). */
const liveRoundTrip = (md: string): string => {
  const json = generateJSON(markdownToHtml(md), extensions); // = setContent
  const html = generateHTML(json, extensions); // = getHTML
  return htmlToMarkdown(html);
};

describe('content-converter live (tiptap) round-trip (2a72ebf4 FIX-3b)', () => {
  it('preserves the code-fence language through tiptap (the FIX-3b regression)', () => {
    expect(liveRoundTrip('```ts\nconst x = 1;\nconst y = 2;\n```')).toBe(
      '```ts\nconst x = 1;\nconst y = 2;\n```',
    );
  });

  it('preserves a no-language fence through tiptap', () => {
    expect(liveRoundTrip('```\nplain code\n```')).toBe('```\nplain code\n```');
  });

  const liveFixtures: Record<string, string> = {
    'heading + inline': '# Title\n\nIntro **bold** with `code` and a [link](https://example.com).',
    'task list': '- [ ] todo\n- [x] done',
    'gfm table inline cells': '| field | value |\n| --- | --- |\n| **bold** | `code` |',
  };

  for (const [name, md] of Object.entries(liveFixtures)) {
    it(`live round-trip is a fixed point: ${name}`, () => {
      expect(liveRoundTrip(md)).toBe(md);
    });
  }
});
