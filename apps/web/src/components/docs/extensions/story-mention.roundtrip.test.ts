// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { generateJSON, generateHTML } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import { htmlToMarkdown, markdownToHtml } from '../lib/content-converter';

// story #3866(카디르 계약값 ⑥ 동형 규율 — 판정 선언은 테스트로 pin) — 페드루 확定
// 처방(2026-09-14 10:48Z): @tiptap/extension-link의 프로토콜 화이트리스트에 `entity`가
// 없어 parseHTML이 `entity:story:<uuid>` href를 거부, 이미 그 링크가 든 문서를 에디터에
// 열면 저장 시 링크가 통째로 사라지는 잠복 결함이었다. doc-editor.tsx와 정확히 같은
// Link.configure(protocols+isAllowedUri)를 이 라이브 왕복 테스트에도 그대로 적용해
// content-converter.tiptap.test.ts의 liveRoundTrip 패턴(schema parse→serialize 실경로)
// 으로 고정한다.
const ENTITY_HREF_RE = /^entity:[a-z_]+:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function makeExtensions(withEntityProtocol: boolean) {
  return [
    StarterKit.configure({ codeBlock: false }),
    withEntityProtocol
      ? Link.configure({
          protocols: [{ scheme: 'entity' }],
          isAllowedUri: (url: string, ctx: { defaultValidate: (u: string) => boolean }) => {
            if (/^entity:/.test(url)) return ENTITY_HREF_RE.test(url);
            return ctx.defaultValidate(url);
          },
        })
      : Link, // 뮤테이션 대조군 — protocols 미등록(doc-editor.tsx 수정 前 상태 재현).
  ];
}

/** content-converter.tiptap.test.ts와 동일 패턴 — markdown → tiptap parse → tiptap
 * serialize → markdown(에디터 load→save 실경로). */
function liveRoundTrip(md: string, withEntityProtocol: boolean): string {
  const extensions = makeExtensions(withEntityProtocol);
  const json = generateJSON(markdownToHtml(md), extensions);
  const html = generateHTML(json, extensions);
  return htmlToMarkdown(html);
}

const STORY_ID = '11111111-2222-3333-4444-555555555555';
const MD_WITH_ENTITY_LINK = `가입 폼 단순화 스토리 — [가입 폼 문서 승인 대기](entity:story:${STORY_ID}) 참고.`;
// 페드루 CHANGES(2026-09-14 11:45Z) — 이 팀 스토리 제목 관례("[SID:NNNN] ...")가 실제
// 링크 텍스트로 그대로 삽입된다(title 새니타이즈 폐기, story-mention.tsx). 이 형태가
// content-converter.ts의 markdownToHtml을 살아남아야 한다(1단 균형 대괄호 지원).
const MD_WITH_BRACKETED_TITLE = `참고: [[SID:3866] 가입 폼 문서 승인 대기](entity:story:${STORY_ID})`;

describe('story-mention 왕복(entity:story: 링크가 에디터 load→save를 살아남는가)', () => {
  it('entity:story: 링크가 든 마크다운이 에디터를 거쳐도 href 그대로 보존된다', () => {
    expect(liveRoundTrip(MD_WITH_ENTITY_LINK, true)).toBe(MD_WITH_ENTITY_LINK);
  });

  it('⭐뮤테이션 대조군 — protocols에 entity 스킴을 안 열면(doc-editor.tsx 수정 前 상태) 링크가 평문으로 떨어진다(이 회귀가 실제로 존재했음을 증명)', () => {
    const result = liveRoundTrip(MD_WITH_ENTITY_LINK, false);
    expect(result).not.toBe(MD_WITH_ENTITY_LINK);
    expect(result).not.toContain(`entity:story:${STORY_ID}`);
  });

  it('entity: 스킴이 아닌 일반 http 링크는 그대로 동작(회귀 0)', () => {
    const md = '[문서](https://example.com/foo)';
    expect(liveRoundTrip(md, true)).toBe(md);
  });

  it('형식이 안 맞는 entity: 문자열(uuid 아님)은 isAllowedUri가 거부 — 평문으로 떨어진다(임의 entity:* 통과 금지)', () => {
    const md = '[이상한 링크](entity:story:not-a-uuid)';
    const result = liveRoundTrip(md, true);
    expect(result).not.toContain('entity:story:not-a-uuid');
  });

  it('⭐대괄호로 시작하는 스토리 제목("[SID:3866] ...")이 링크 텍스트에 그대로 들어 있어도 왕복이 항등(같은 사실은 같은 낱말로 — 새니타이즈 폐기 회귀가드)', () => {
    expect(liveRoundTrip(MD_WITH_BRACKETED_TITLE, true)).toBe(MD_WITH_BRACKETED_TITLE);
  });

  it('⭐뮤테이션 대조군 — markdownToHtml이 옛 좁은 정규식(`[^\\]]+`)이면 대괄호 제목 링크가 평문으로 깨진다(이 CHANGES가 고친 결함이 실제로 있었음을 증명)', () => {
    // content-converter.ts를 직접 되돌리지 않고, 여기서 옛 정규식으로 같은 입력을 처리해
    // "그때는 이랬다"를 재현한다(원본 파일 mutate 없이 대조군 확보 — 원본은 항상 새 정규식).
    const oldMarkdownToHtmlLinks = (html: string) =>
      html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m: string, text: string, href: string) => `<a href="${href}">${text}</a>`);
    const html = oldMarkdownToHtmlLinks(MD_WITH_BRACKETED_TITLE);
    // 옛 정규식은 "[SID:3866]"의 안쪽 `]`에서 멈춰버려 `<a href=...>`가 아예 안 만들어진다.
    expect(html).not.toContain('<a href="entity:story:');
  });
});

describe('story-mention 왕복 — sprintable reference_token 백슬래시 이스케이프 형식도 파서를 통과', () => {
  // reference_token은 제목 안 `[`·`]`를 `\[`·`\]`로 이스케이프해 내보낸다(sprintable
  // search_stories 실측: "[\\[SID:3864\\] ...]"). 이 형식이 붙여넣기 등으로 문서에 들어와도
  // markdownToHtml이 깨지면 안 된다(페드루 CHANGES) — 항등 왕복까지는 요구하지 않는다
  // (Turndown이 재직렬화할 때 raw 대괄호로 정규화하는 게 오히려 맞다), 파싱 자체가 진짜
  // `<a>` 앵커를 만들어내는지만 pin한다.
  const MD_WITH_ESCAPED_BRACKETS = `참고: [\\[SID:3864\\] CI 인프라](entity:story:${STORY_ID})`;

  it('백슬래시로 이스케이프된 대괄호 제목도 markdownToHtml이 진짜 <a> 앵커를 만든다(깨지지 않는다)', () => {
    const html = markdownToHtml(MD_WITH_ESCAPED_BRACKETS);
    expect(html).toContain(`<a href="entity:story:${STORY_ID}">`);
  });

  it('⭐뮤테이션 대조군 — 옛 좁은 정규식이면 이스케이프된 대괄호 제목도 앵커가 안 만들어진다', () => {
    const oldMarkdownToHtmlLinks = (html: string) =>
      html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m: string, text: string, href: string) => `<a href="${href}">${text}</a>`);
    const html = oldMarkdownToHtmlLinks(MD_WITH_ESCAPED_BRACKETS);
    expect(html).not.toContain(`<a href="entity:story:${STORY_ID}">`);
  });
});
