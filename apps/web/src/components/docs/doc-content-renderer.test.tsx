import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// DOMPurify runs only in browser environments. Mock it as an identity function so
// the server-side heading sanitisation logic (attrs removal + sanitizeHeadingInner)
// is exercised without needing a real DOM.
vi.mock('dompurify', () => ({
  default: { sanitize: (html: string) => html },
}));

import { DocContentRenderer } from './doc-content-renderer';

describe('DocContentRenderer', () => {
  it('renders raw html embedded in markdown instead of exposing escaped tags', () => {
    const markup = renderToStaticMarkup(
      <DocContentRenderer content={'<h2>제목</h2>\n\n본문'} contentFormat="markdown" />,
    );

    expect(markup).toContain('<h2 id="제목">제목</h2>');
    expect(markup).toContain('<p>본문</p>');
    expect(markup).not.toContain('&lt;h2&gt;');
  });

  it('adds stable heading anchors and copy actions for markdown docs', () => {
    const markup = renderToStaticMarkup(
      <DocContentRenderer
        content={'# Overview\n\n<h2>HTML Heading In Markdown</h2>\n\n```ts\nconst answer = 42;\n```\n\n| col | val |\n| --- | --- |\n| a | b |'}
        contentFormat="markdown"
        codeCopyLabel="Copy code"
      />,
    );

    expect(markup).toContain('<h1 id="overview">Overview</h1>');
    expect(markup).toContain('<h2 id="html-heading-in-markdown">HTML Heading In Markdown</h2>');
    // Markdown code blocks render via the self-contained React CodeBlock (own onClick +
    // state), so the copy action is the data-doc-code-actions shell + label, not the
    // HTML-path data-doc-copy-button marker (that marker is asserted in the html test below).
    expect(markup).toContain('data-doc-code-actions="true"');
    expect(markup).toContain('Copy code');
    expect(markup).toContain('<table>');
  });

  it('decorates html docs with heading anchors, table shells, and copy actions', () => {
    const markup = renderToStaticMarkup(
      <DocContentRenderer
        content={'<h1>HTML Title</h1><table><thead><tr><th>A</th></tr></thead><tbody><tr><td>B</td></tr></tbody></table><pre><code>SELECT 1;</code></pre>'}
        contentFormat="html"
        codeCopyLabel="Copy"
      />,
    );

    expect(markup).toContain('<h1 id="html-title">HTML Title</h1>');
    expect(markup).toContain('data-doc-copy-button="true"');
    expect(markup).toContain('overflow-x-auto');
    expect(markup).toContain('SELECT 1;');
  });

  it('story #1996: preserves pageEmbed data attributes through markdown sanitize (previously stripped, grep 0 handler)', () => {
    const markup = renderToStaticMarkup(
      <DocContentRenderer
        content={'<div data-page-embed data-doc-id="doc-1" data-title="설계 문서" data-icon="📄" data-slug="design-doc"></div>'}
        contentFormat="markdown"
      />,
    );

    // rehype-sanitize의 기존 스키마는 이 속성들이 allowlist 밖이라 전부 걷어냈다 — 스키마
    // 확장이 없으면 이 assertion들이 실패해 회귀를 잡는다.
    expect(markup).toContain('data-page-embed');
    expect(markup).toContain('data-title="설계 문서"');
    expect(markup).toContain('data-slug="design-doc"');
  });

  it('sanitizes dangerous heading attributes and inner tags', () => {
    const markup = renderToStaticMarkup(
      <DocContentRenderer
        content={'<h1 onclick="alert(1)">제목</h1><h2><img src=x onerror="alert(2)"><strong>ok</strong></h2>'}
        contentFormat="html"
      />,
    );

    // heading element itself must not carry event-handler attributes
    expect(markup).not.toContain(' onclick=');
    // dangerous inner tags must be escaped — no live <img> element in output
    expect(markup).not.toContain('<img ');
    // safe inline tags inside heading inner are preserved by sanitizeHeadingInner
    expect(markup).toContain('<strong>ok</strong>');
  });

  // story #2639 — 본문 entity: 참조가 죽은 링크(스타일만·href 지워짐)로 떨어지던 갭. 이제
  // chat/story-panel과 동일하게 EntityChip(상호작용 버튼)으로 렌더돼 앱 내 엔티티로 잇는다.
  it('story #2639: renders entity refs as interactive chips (not dead links) — story·epic·doc', () => {
    const uuid = '11111111-1111-1111-1111-111111111111';
    const markup = renderToStaticMarkup(
      <DocContentRenderer
        content={`참조: [스토리제목](entity:story:${uuid}) [에픽제목](entity:epic:${uuid}) [문서제목](entity:doc:${uuid})`}
        contentFormat="markdown"
      />,
    );

    // 죽은 앵커가 아니라 상호작용 칩(button)으로 렌더. 라벨 텍스트는 3종 모두 살아 있다.
    expect(markup).toContain('<button type="button"');
    expect(markup).toContain('스토리제목');
    expect(markup).toContain('에픽제목');
    expect(markup).toContain('문서제목');
    // 유효 UUID 3종은 전부 칩으로 흡수 → entity: 원시 스킴이 앵커 href로 새지 않는다.
    expect(markup).not.toContain('href="entity:');
  });

  // 뮤테이션 자가검증 — 두 겹 필터(urlTransform + rehype-sanitize protocols.href) 중 하나라도
  // 빠지면 href가 지워져 정규식 매칭이 실패, 평문 링크로 떨어지고 이 assertion이 깨진다.
  it('story #2639 mutation guard: entity: scheme survives BOTH the urlTransform and sanitize filters', () => {
    const uuid = '22222222-2222-2222-2222-222222222222';
    const markup = renderToStaticMarkup(
      <DocContentRenderer content={`[칩라벨](entity:story:${uuid})`} contentFormat="markdown" />,
    );
    expect(markup).toContain('<button type="button"');
    expect(markup).toContain('칩라벨');
  });

  // 보안 비회귀 — entity: 예외가 다른 위험 스킴을 함께 열어주지 않는다(기본 sanitize 유지).
  it('story #2639 security non-regression: javascript:/data: hrefs are still stripped', () => {
    const markup = renderToStaticMarkup(
      <DocContentRenderer content={'[x](javascript:alert(1)) [y](data:text/plain,hi)'} contentFormat="markdown" />,
    );
    expect(markup).not.toContain('javascript:');
    expect(markup).not.toContain('data:text/plain');
  });

  // public share 뷰어 — 내부 엔티티 참조는 비활성 평문(메타 유출 경계·wikiLink publicMode와 동일).
  it('story #2639: public share viewer renders entity refs inert (no chip button)', () => {
    const uuid = '33333333-3333-3333-3333-333333333333';
    const markup = renderToStaticMarkup(
      <DocContentRenderer content={`[내부참조](entity:story:${uuid})`} contentFormat="markdown" publicMode />,
    );
    expect(markup).toContain('내부참조');
    expect(markup).not.toContain('<button type="button"');
  });
});
