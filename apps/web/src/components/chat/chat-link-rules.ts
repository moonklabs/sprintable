// story 4854 — what a chat message may turn into a link, and where an address goes. Pure (no React) so the rules are tested without a DOM.
//
// Why this file exists: a message with no markdown character at all took the plain path of ChatMarkdown (`<span>{content}</span>`), so a bare address in it was never a link — on the web, in the Mac app and in the phone app alike —
// and an e-mail address's «@example» was turned into a mention link, which broke a mailto: link.

export type ChatHrefKind = 'web' | 'mail' | 'none';

/** which kind of link an address is: `web` (http · https — opens in a new tab on the web; the Mac and phone shells show an address of this service in their own window and send the rest to the system browser),
 *  `mail` (mailto:), `none` (an empty address — a `javascript:` link the markdown reader already emptied — or any other kind: it is text, not a link). The shells hold the same list again (http · https · mailto). */
export function classifyChatHref(href: unknown): ChatHrefKind {
  if (typeof href !== 'string' || href === '') return 'none';
  if (/[\u0000- \u007f-\u009f]/.test(href)) return 'none'; // any space or control character, a leading one included (` javascript:…`)
  let protocol: string;
  try { protocol = new URL(href).protocol; } catch { return 'none'; } // a relative or scheme-less address is not something a chat link means
  if (protocol === 'http:' || protocol === 'https:') return 'web';
  if (protocol === 'mailto:') return 'mail';
  return 'none';
}

export type PlainPart = { kind: 'text'; value: string } | { kind: 'url'; value: string };

// the characters of an address (RFC 3986): it stops at a space, a quote, an angle bracket and at any non-ASCII character — a Korean particle written right after an address is not part of it
const URL_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/gi;

/** an address followed by sentence punctuation or by the bracket that closes a phrase: the punctuation / the unbalanced closing bracket is not part of the address */
function trimTail(url: string): string {
  let u = url;
  for (;;) {
    const last = u[u.length - 1];
    if (last !== undefined && '.,;:!?\''.includes(last)) { u = u.slice(0, -1); continue; }
    const pair = last === ')' ? '(' : last === ']' ? '[' : null;
    if (pair && u.split(last!).length > u.split(pair).length) { u = u.slice(0, -1); continue; } // more closers than openers: the last one closes the sentence's bracket
    return u;
  }
}

/** a plain message cut into text and addresses (http · https only; mailto addresses and `www.` words stay text here — the markdown path of the bubble links those) */
export function splitPlainUrls(text: string): PlainPart[] {
  const parts: PlainPart[] = [];
  let from = 0;
  for (const m of text.matchAll(URL_RE)) {
    const at = m.index ?? 0;
    if (at < from) continue;
    if (at > 0 && /[A-Za-z0-9]/.test(text[at - 1] ?? '')) continue; // `xhttp://…` is a word, not an address
    const url = trimTail(m[0]);
    if (!/^https?:\/\/[^\s/?#]+/i.test(url)) continue;
    if (at > from) parts.push({ kind: 'text', value: text.slice(from, at) });
    parts.push({ kind: 'url', value: url });
    from = at + url.length;
  }
  if (from < text.length) parts.push({ kind: 'text', value: text.slice(from) });
  return parts;
}

/** a mention is an `@name` that starts a word: the «@example» inside `probe@example.org` is not one */
export const MENTION_RE = /(?<![\w.+\-[(])@([\w가-힣]+)/g;
export const HAS_MENTION_RE = /(?<![\w.+\-[(])@[\w가-힣]+/;
