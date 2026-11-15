// story 4887 (UI-4 P1) — the ONE line a chat-list row shows for an ordinary message: the message is READ AS MARKDOWN with the bubble's own parser family (react-markdown = remark + GFM;
// chat-bubble.tsx) and only its text is kept — no `**` / `__` / `*` / `_` / `~~` markers, no heading · quote · list marks, no code fences or backticks — while the text inside code stays as written.
// What the bubble shows as text, the preview shows as text: raw HTML (the bubble has no rehype-raw — a tag is shown escaped) stays; an HTML comment (the bubble hides it) goes; a link shows its label,
// an image its alt. A message that is only rules / an empty fence (`*****`) has no text — it shows as written. Line breaks (and runs of spaces) become one space: the row is one line.
// The bubble only renders MARKDOWN for a message that carries a marker (chat-bubble.tsx: `markdownish`); any other message is shown as written (`- one`, a `| a | b |` table stay literal) — the preview follows the same gate.
// Its own module on purpose: `entity-ref.ts` is imported by the global top bar and many screens — the parser must not ride along with them; only the room list imports this.
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { HAS_MENTION_RE } from './chat-link-rules'; // the bubble's own mention test (also a markdown-route switch there)

/** how much of the message is parsed (a longer message is cut here, after dropping a lone high surrogate) — and how much of the result is kept */
const PARSE_MAX = 4000;
const PREVIEW_MAX = 1000;
const PARSER = unified().use(remarkParse).use(remarkGfm);
const COMMENT_RE = /<!--[\s\S]*?(?:-->|$)/g;
/** the bubble's own route test (chat-bubble.tsx `markdownish` · and `hasMention` — a message with an @mention also goes the markdown route there; both pinned to that source by tests): a marker character, an `entity:` reference, or — when the text carries an HTML comment — an indented line / a list item */
function isMarkdownish(content: string): boolean {
  const hasComment = content.includes('<!--');
  const detection = hasComment ? content.replace(COMMENT_RE, '') : content;
  const markdownish = /[*_`#\[\]>~]|entity:/.test(detection)
    || (hasComment && (/^(?: {4}|\t)/m.test(content) || /^\s*(?:[-*+]|\d+[.)])\s/m.test(detection)));
  return markdownish || HAS_MENTION_RE.test(hasComment ? detection : content);
}
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();
interface PreviewNode { type: string; value?: string; alt?: string | null; children?: PreviewNode[] }
// nodes after which one space must stand, or two paragraphs / list items / table cells would run together
const BLOCKS = new Set(['paragraph', 'heading', 'listItem', 'tableCell', 'blockquote', 'code']);

// (a rule `thematicBreak` and a link `definition` carry no text and no children, so they add nothing — no case needed)
function collect(node: PreviewNode, out: string[]): void {
  if (node.type === 'html') { out.push((node.value ?? '').replace(COMMENT_RE, '')); return; } // a tag shows as text (no rehype-raw in the bubble); a comment — also inside a larger tag — is hidden
  if (node.type === 'footnoteDefinition') return; // the bubble prints footnotes at the end as a list: the row is the beginning of the message
  if (node.type === 'break') { out.push(' '); return; }
  if (node.type === 'image' || node.type === 'imageReference') { if (node.alt) out.push(node.alt); return; }
  if (typeof node.value === 'string') out.push(node.type === 'text' ? node.value.replace(COMMENT_RE, '') : node.value); // text (a stray or cut `<!--` is hidden, as in the bubble) · inlineCode · code — kept as written
  for (const child of node.children ?? []) collect(child, out);
  if (BLOCKS.has(node.type)) out.push(' ');
}

/** a cut that never leaves half a surrogate pair */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head;
}

export function toListPreview(content: string): string {
  const source = cut(content, PARSE_MAX);
  if (!isMarkdownish(source)) return cut(oneLine(source.replace(COMMENT_RE, '')), PREVIEW_MAX); // shown as written in the bubble — and so here
  const out: string[] = [];
  collect(PARSER.parse(source) as unknown as PreviewNode, out);
  // no text at all (only rules / an empty fence): the row shows the source as written, minus comments — not an empty row
  return cut(oneLine(out.join('')) || oneLine(source.replace(COMMENT_RE, '')), PREVIEW_MAX);
}
