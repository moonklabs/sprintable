// @vitest-environment jsdom
/**
 * story #4339(까디르 4708 ② · PO 판단 (a)) — **마크다운 문서** 저장 경로에서도 부품 값이 산다: md → markdownToHtml → 편집기(실 확장 목록) →
 * getHTML → htmlToMarkdown → 같은 md.
 *
 * 재다가 나온 손실(develop부터): turndown은 규칙보다 먼저 «빈 노드»를 blankReplacement로 보내 버려, 내용 없는 부품 div인 **링크 카드 ·
 * 문서 임베드가 저장 때 통째로 사라졌다**(첨부만 특례로 살아 있었음). 이제 빈 부품은 content-converter의 EMPTY_PART_SERIALIZERS 한 곳에서
 * 보존하고, 아래 가드가 왕복 픽스처의 빈 부품 뿌리가 전부 거기 걸리는지 대조한다(새 빈 부품이 조용히 버려지지 않게).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { EMPTY_PART_SERIALIZERS, htmlToMarkdown, markdownToHtml } from './lib/content-converter';
import { makeDocEditor, partsOf, PARTS_FIXTURE } from './doc-editor-roundtrip.fixture';

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useParams: () => ({ ws: 'ws-1', proj: 'proj-b' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('@/hooks/use-flat-href', () => ({ useFlatHref: () => (h: string) => h }));

const { DocContentRenderer } = await import('./doc-content-renderer');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 바뀐 노드마다 사례 하나 — 저장 형식(md)은 편집기 HTML을 htmlToMarkdown한 것. */
const CHANGED_PARTS: Record<string, string> = {
  linkCard: '<div data-type="embedBlock" data-url="https://example.com/"></div>',
  pageEmbed: '<div data-page-embed="" data-doc-id="64c2e43b-4323-4714-b49e-61f0b70fea60" data-title="공유 &quot;시각&quot; 검증" data-icon="📄" data-slug="ortega-visual-share"></div>',
  toggle: '<div data-type="toggleBlock" data-open="true"><div data-type="toggleSummary">토글 제목</div><div data-type="toggleContent"><p>토글 안 내용</p></div></div>',
  math: '<div data-type="mathBlock" data-latex="E=mc^2">E=mc^2</div>',
  wikiLink: '<p><span data-type="wikiLink" data-doc-id="d0c1d000-0000-4000-8000-000000000002" data-title="다른 문서" data-slug="other-doc">다른 문서</span></p>',
  columns: '<div data-type="columnsBlock" data-cols="2"><div data-type="columnBlock"><p>왼쪽</p></div><div data-type="columnBlock"><p>오른쪽</p></div></div>',
};

function editorRoundTrip(md: string): string {
  const editor = makeDocEditor(markdownToHtml(md));
  try {
    return htmlToMarkdown(editor.getHTML());
  } finally {
    editor.destroy();
  }
}

describe('마크다운 문서 저장 왕복 — 바뀐 부품마다(story #4339 · 까디르 4708 ②)', () => {
  it.each(Object.entries(CHANGED_PARTS))('⭐%s — md → 편집기 → md가 같고 · 부품 값이 산다', (_name, html) => {
    const md = htmlToMarkdown(html);
    expect(md, '저장 형식이 비지 않는다(예전: 링크 카드 · 문서 임베드는 "")').not.toBe('');
    expect(editorRoundTrip(md)).toBe(md);
    const [before] = partsOf(html);
    const [after] = partsOf(markdownToHtml(editorRoundTrip(md)));
    expect(after?.attrs).toMatchObject(before!.attrs);
  });

  it('⭐문단 사이의 링크 카드 · 문서 임베드도 저장에서 안 사라진다(예전: `a\\n\\nb`만 남음)', () => {
    const md = htmlToMarkdown(`<p>a</p>${CHANGED_PARTS.linkCard}${CHANGED_PARTS.pageEmbed}<p>b</p>`);
    expect(md).toContain('data-url="https://example.com/"');
    expect(md).toContain('data-slug="ortega-visual-share"');
    expect(editorRoundTrip(md)).toBe(md);
  });

  it('⭐가드 — 왕복 픽스처의 **빈 부품 뿌리**(자식 · 글 없는 부품)는 전부 EMPTY_PART_SERIALIZERS에 걸린다(새 빈 부품이 저장에서 조용히 버려지지 않게)', () => {
    const root = document.createElement('div');
    root.innerHTML = PARTS_FIXTURE;
    const emptyRoots = [...root.querySelectorAll<HTMLElement>('[data-type], [data-page-embed]')].filter((el) => el.childNodes.length === 0);
    expect(emptyRoots.length, '빈 부품을 실제로 모았다').toBeGreaterThanOrEqual(3);
    const uncaught = emptyRoots.filter((el) => !EMPTY_PART_SERIALIZERS.some((p) => p.matches(el))).map((el) => el.outerHTML.slice(0, 80));
    expect(uncaught).toEqual([]);
    for (const el of emptyRoots) expect(htmlToMarkdown(el.outerHTML), el.outerHTML.slice(0, 60)).not.toBe('');
  });

  it('속성 값은 escape되어 raw HTML 밖으로 새지 않는다(따옴표 · 꺾쇠)', () => {
    const md = htmlToMarkdown('<div data-type="embedBlock" data-url="https://e.com/?q=&quot;&gt;&lt;x"></div>');
    const [part] = partsOf(markdownToHtml(md));
    expect(part?.attrs['data-url']).toBe('https://e.com/?q="><x');
    expect(md).not.toMatch(/data-url="[^"]*"[^>]*"/);
  });
});

describe('보안 — 마크다운에 raw HTML로 남는 data-url은 읽을 때 4324 안전 도우미를 그대로 지난다(새 싱크 0)', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

  it('⭐javascript: 링크 카드를 저장(md) → 읽기 화면으로 그리면 그 주소로 가는 링크 · 틀이 없다', async () => {
    const md = htmlToMarkdown('<div data-type="embedBlock" data-url="javascript:alert(1)"></div>');
    expect(md, '값은 보존(판정은 읽을 때)').toContain('javascript:alert(1)');
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <DocContentRenderer content={`${md}\n`} contentFormat="markdown" untitledEmbedLabel="제목 없음" embedNotFoundLabel="문서를 찾을 수 없어요" unsafeLinkLabel={koMessages.docs.embedLinkBlocked} unsafeFileLabel={koMessages.docs.attachFileBlocked} wikiLinkTargets={{}} />
        </NextIntlClientProvider>,
      );
    });
    for (const a of container.querySelectorAll('a')) expect(a.getAttribute('href') ?? '').not.toMatch(/^\s*javascript:/i);
    for (const f of container.querySelectorAll('iframe')) expect(f.getAttribute('src') ?? '').not.toMatch(/^\s*javascript:/i);
    expect(container.textContent).toContain(koMessages.docs.embedLinkBlocked);
  });
});
