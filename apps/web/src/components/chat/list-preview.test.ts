// story 4887 (UI-4 P1) — the one-line summary of a chat-list row: the text the bubble would SHOW, no markdown markers (the dev capture showed «**주간 요약** - 완료 12건 …» in a row).
// The message is read with the bubble's own parser family (remark + GFM), so what counts as emphasis is what the bubble renders as emphasis.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toListPreview } from './list-preview';

describe('toListPreview (story 4887)', () => {
  it('bold · italic · strike markers go, the words stay', () => {
    expect(toListPreview('**주간 요약** 끝')).toBe('주간 요약 끝');
    expect(toListPreview('__굵게__ 와 *기울임* 과 _기울임2_ 와 ~~취소~~')).toBe('굵게 와 기울임 과 기울임2 와 취소');
  });
  it('the dev capture: a heading + list message reads as one plain line', () => {
    expect(toListPreview('**주간 요약**\n- 완료 12건\n- 진행 4건\n- 막힘 1건 (결제 키 만료)\n\n다음 단계는 키 교체예요.'))
      .toBe('주간 요약 완료 12건 진행 4건 막힘 1건 (결제 키 만료) 다음 단계는 키 교체예요.');
  });
  it('headings · quotes · numbered lists lose their line-start marks (nested quotes too)', () => {
    expect(toListPreview('# 제목\n> 인용\n1. 하나\n2) 둘')).toBe('제목 인용 하나 둘');
    expect(toListPreview('> > **x**')).toBe('x');
  });
  it('inline code and fenced code keep the code as written, lose the delimiters', () => {
    expect(toListPreview('`pnpm test` 는 초록')).toBe('pnpm test 는 초록');
    expect(toListPreview('`**literal**`')).toBe('**literal**');
    expect(toListPreview('쓰는 법: `_a_ 와 *b*` 끝')).toBe('쓰는 법: _a_ 와 *b* 끝');
    expect(toListPreview('```ts\nconst a = 1;\n```')).toBe('const a = 1;');
    expect(toListPreview('```\n# not a heading\n- not a bullet\n```')).toBe('# not a heading - not a bullet');
  });
  it('a link inside code is NOT resolved (the bubble shows it as written there) — a link outside code shows its label', () => {
    expect(toListPreview('```\n[alt](https://x)\n```')).toBe('[alt](https://x)');
    expect(toListPreview('`[alt](https://x)`')).toBe('[alt](https://x)');
    expect(toListPreview('**참고:** [공지](https://example.com/notice)')).toBe('참고: 공지');
    expect(toListPreview('문서 [A \\] B](https://example.com/a)')).toBe('문서 A ] B');
  });
  it('an unclosed fence and a four-backtick fence keep their code too', () => {
    expect(toListPreview('```ts\n**literal**\n# not heading')).toBe('**literal** # not heading');
    expect(toListPreview('````ts\n**literal**\n````')).toBe('**literal**');
  });
  it('emphasis around inline code · compound emphasis · full-width punctuation all strip', () => {
    expect(toListPreview('**before `code` after**')).toBe('before code after');
    expect(toListPreview('***bold***')).toBe('bold');
    expect(toListPreview('**안녕**。 와 「**확인**」')).toBe('안녕。 와 「확인」');
    expect(toListPreview('(**확인**) 와 "*끝*." 와 **끝**!')).toBe('(확인) 와 "끝." 와 끝!');
  });
  it('underscores inside words are not emphasis — they stay as written', () => {
    for (const same of ['foo__bar__baz', 'snake_case_name', '안_녕_하세요']) expect(toListPreview(same), same).toBe(same);
  });
  it('text with no markdown comes back unchanged; a lone marker with spaces stays', () => {
    expect(toListPreview('그냥 평범한 메시지입니다')).toBe('그냥 평범한 메시지입니다');
    expect(toListPreview('별표 하나 * 만 과 ** ** 둘')).toBe('별표 하나 * 만 과 ** ** 둘');
  });
  it('a message that is only a rule or an empty fence has no text — it shows as written, not as an empty row', () => {
    for (const same of ['*****', '_____', '~~~~~']) expect(toListPreview(same), same).toBe(same);
  });
  it('raw HTML shows as text (the bubble has no rehype-raw); an HTML comment is hidden', () => {
    expect(toListPreview('앞 <b>굵게</b> 뒤')).toBe('앞 <b>굵게</b> 뒤');
    expect(toListPreview('앞 <!-- 숨김 --> 뒤')).toBe('앞 뒤');
  });
  it('an image shows its alt text — also a reference-style image, whose definition line is not text', () => {
    expect(toListPreview('참고: ![스크린샷](https://x.png) 확인')).toBe('참고: 스크린샷 확인');
    expect(toListPreview('![alt][id]\n\n[id]: https://x/y.png')).toBe('alt');
  });
  it('line breaks become one space (also hard breaks); runs of spaces — in code too — collapse; empty stays empty', () => {
    expect(toListPreview('가\n\n나')).toBe('가 나');
    expect(toListPreview('가  \n나')).toBe('가 나'); // a hard break (two trailing spaces)
    expect(toListPreview('가\\\n나')).toBe('가\\ 나'); // no marker character → the bubble shows it as written (the backslash too)
    expect(toListPreview('```\n  a   b\n```')).toBe('a b');
    expect(toListPreview('')).toBe('');
  });
  it('the cap: a result is at most 1000 characters; a cut never leaves half a surrogate pair', () => {
    expect(toListPreview('가'.repeat(5000)).length).toBe(1000);
    const out = toListPreview('a'.repeat(999) + '😀');
    expect(out).toBe('a'.repeat(999));
    expect(/[\uD800-\uDBFF]$/.test(out)).toBe(false);
  });
  it('a very long unclosed-marker message stays cheap and still has text; only-rules input is capped too', () => {
    const out = toListPreview('**a '.repeat(8000));
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(1000);
    expect(toListPreview('*****\n'.repeat(200) + 'TAIL')).toBe('TAIL');
    expect(toListPreview('*****\n'.repeat(500)).length).toBeLessThanOrEqual(1000);
    // only the first 4000 characters are parsed: text that starts after that is not read (the row is one line — the beginning is what it shows)
    const late = toListPreview('*****\n'.repeat(1000) + 'TAIL');
    expect(late).not.toContain('TAIL');
    expect(late.startsWith('*****')).toBe(true);
    expect(late.length).toBeLessThanOrEqual(1000);
  });

  // codex round 4: the bubble renders markdown only for a message that carries a marker; everything else is shown as written
  it('a message with no markdown marker is shown as written — list marks and tables stay literal, like the bubble', () => {
    expect(toListPreview('- one\n- two')).toBe('- one - two');
    expect(toListPreview('1. a\n2. b')).toBe('1. a 2. b');
    expect(toListPreview('| A | B |\n|---|---|\n| 1 | 2 |')).toBe('| A | B | |---|---| | 1 | 2 |');
    expect(toListPreview('- one\n- **two**')).toBe('one two'); // one marker anywhere → the whole message is markdown
  });
  it('the gate is the bubble\'s own: the regex is pinned to chat-bubble.tsx so the two cannot drift apart', () => {
    const bubble = readFileSync(join(__dirname, 'chat-bubble.tsx'), 'utf8');
    expect(bubble).toContain("/[*_`#\\[\\]>~]|entity:/.test(detectionText)");
    expect(bubble).toContain("(/^(?: {4}|\\t)/m.test(rawContent) || /^\\s*(?:[-*+]|\\d+[.)])\\s/m.test(detectionText))");
  });
  it('footnote definitions are not part of the row (the bubble prints them at the end); a comment — alone or inside a larger tag — is hidden', () => {
    expect(toListPreview('before[^a] after\n\n[^a]: first\n\n[^b]: unused')).toBe('before after');
    expect(toListPreview('<div><!-- hidden -->text</div>')).toBe('<div>text</div>');
    expect(toListPreview('<!-- only -->')).toBe('');
  });
  // mutants that survived the first pass: each pins one branch the other tests did not reach
  it('a hard break inside a message that IS markdown becomes one space (both forms)', () => {
    expect(toListPreview('**가**  \n나')).toBe('가 나'); // two trailing spaces
    expect(toListPreview('**가**\\\n나')).toBe('가 나'); // a backslash
  });
  it('a message with only a rule and a comment shows the rule as written, without the comment', () => {
    expect(toListPreview('*****\n<!-- c -->')).toBe('*****');
  });
  it('a message with an HTML comment and a plain list is markdown for the bubble (the comment rule of its gate) — the list marks go', () => {
    expect(toListPreview('<!-- c -->\n- one\n- two')).toBe('one two');
    expect(toListPreview('- one\n- two')).toBe('- one - two'); // without the comment it stays literal (previous test)
  });
  // codex round 5 (PR 5495): a cut or unclosed comment inside text, and the bubble's second route switch (an @mention)
  it('a stray or cut HTML comment inside text is hidden (the bubble shows only what is before it)', () => {
    expect(toListPreview('**x** <!-- unclosed')).toBe('x');
    expect(toListPreview('**x** <!-- c --> y')).toBe('x y');
  });
  it('a message with an @mention goes the markdown route, like the bubble — a list mark in front of it goes; a lone @ does not count', () => {
    expect(toListPreview('- @alice')).toBe('@alice');
    expect(toListPreview('1. @알리스 확인')).toBe('@알리스 확인');
    expect(toListPreview('- one @ two')).toBe('- one @ two');
    expect(toListPreview('mail me at a@b.com\n- one')).toBe('mail me at a@b.com - one'); // an address is not a mention (the bubble's own rule)
  });
  it('the mention switch is the bubble\'s own: pinned to chat-bubble.tsx and imported from the same rules module', () => {
    const bubble = readFileSync(join(__dirname, 'chat-bubble.tsx'), 'utf8');
    expect(bubble).toContain('HAS_MENTION_RE.test(content)');
    expect(bubble).toContain("from './chat-link-rules'");
  });
});
