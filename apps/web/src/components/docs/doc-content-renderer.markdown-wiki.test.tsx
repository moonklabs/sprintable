// @vitest-environment jsdom
// story #4313 — 마크다운 문서의 위키 링크: «[[slug]]» · «[[slug|글]]» · 에디터 위키 링크 span이 **실재 문서일 때만** 4309와 같은 진짜 링크
// (`/{ws}/{proj}/docs/{slug}` · 탭 순서 · 보통 클릭 = 클라이언트 이동 · 수정 키 = 브라우저). 없는 문서 · 실재 집합을 모르는 소비처는 글자 그대로
// (깨진 링크 0) · 코드 안 무변 · publicMode 평문 · sanitize는 필요한 data 셋만.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useParams: () => ({ ws: 'ws-1', proj: 'proj-b' }),
  useRouter: () => ({ push: nav.push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('@/hooks/use-flat-href', () => ({ useFlatHref: () => (h: string) => `${h}${h.includes('?') ? '&' : '?'}p=P` }));

import { DocContentRenderer } from './doc-content-renderer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 적힌 slug → 지금 slug(`wiki_link_targets`). 옛 이름 old-design은 이름 바뀐 design-doc(alias · PO 13:44Z).
const EXISTING: Record<string, string> = { 'design-doc': 'design-doc', onboarding: 'onboarding', 'old-design': 'design-doc' };

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  nav.push.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

async function renderDoc(content: string, opts: { format?: 'html' | 'markdown'; publicMode?: boolean; wikiLinkTargets?: Record<string, string> | null } = {}) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <DocContentRenderer
          content={content}
          contentFormat={opts.format ?? 'markdown'}
          publicMode={opts.publicMode}
          untitledEmbedLabel="제목 없음" embedNotFoundLabel="문서를 찾을 수 없어요" unsafeLinkLabel="열 수 없는 링크예요" unsafeFileLabel="이 파일은 열 수 없어요"
          wikiLinkTargets={opts.wikiLinkTargets === undefined ? EXISTING : opts.wikiLinkTargets}
        />
      </NextIntlClientProvider>,
    );
  });
}
const docLinks = () => [...container.querySelectorAll<HTMLAnchorElement>('a[data-doc-internal-link]')];
function click(el: Element, init: MouseEventInit = {}): boolean {
  let notPrevented = true;
  act(() => { notPrevented = el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init })); });
  return notPrevented;
}

describe('DocContentRenderer — 마크다운 위키 링크(story #4313)', () => {
  it('⭐«[[slug]]» · «[[slug|글]]» — 실재 문서면 진짜 링크(주소 · 탭 순서 · 이름 = 보이는 글)', async () => {
    await renderDoc('앞 [[onboarding]] 가운데 [[design-doc|설계 문서]] 뒤');
    const links = docLinks();
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/ws-1/proj-b/docs/onboarding', '/ws-1/proj-b/docs/design-doc']);
    expect(links.map((a) => a.textContent)).toEqual(['onboarding', '설계 문서']);
    expect(links.every((a) => a.tabIndex === 0)).toBe(true);
    expect(container.textContent).toBe('앞 onboarding 가운데 설계 문서 뒤');
  });

  it('⭐보통 클릭 = 클라이언트 이동(기본 동작 막음) · ⌘/Ctrl/Shift/Alt · 가운데 = 브라우저(라우터 0)', async () => {
    await renderDoc('[[design-doc|설계]]');
    const link = docLinks()[0]!;
    for (const mod of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      expect(click(link, mod), JSON.stringify(mod)).toBe(true);
    }
    expect(nav.push).not.toHaveBeenCalled();
    expect(click(link)).toBe(false);
    expect(nav.push).toHaveBeenCalledWith('/ws-1/proj-b/docs/design-doc');
  });

  it('⭐없는 문서(에이전트 기억 파일 이름 등)는 원문 글자 그대로 — 깨진 링크 0', async () => {
    await renderDoc('[[feedback_memory_file]] 과 [[missing|안 보임]] 그리고 [[onboarding]]');
    expect(docLinks().map((a) => a.getAttribute('href'))).toEqual(['/ws-1/proj-b/docs/onboarding']);
    expect(container.textContent).toContain('[[feedback_memory_file]]');
    expect(container.textContent).toContain('[[missing|안 보임]]');
  });

  it('⭐코드 블록 · 인라인 코드 안은 무변', async () => {
    await renderDoc('`[[onboarding]]`\n\n```\n[[design-doc]]\n```\n');
    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(container.textContent).toContain('[[onboarding]]');
    expect(container.textContent).toContain('[[design-doc]]');
  });

  it('⭐마크다운 속 에디터 위키 링크 span — sanitize 뒤에도 실재면 링크(제목 유지) · 없으면 글자 그대로', async () => {
    await renderDoc(
      '앞 <span data-type="wikiLink" data-doc-id="d1" data-title="설계 문서" data-slug="design-doc">설계 문서</span> · '
      + '<span data-type="wikiLink" data-doc-id="d2" data-title="없는 것" data-slug="gone-doc">없는 것</span> 뒤',
    );
    const links = docLinks();
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute('href')).toBe('/ws-1/proj-b/docs/design-doc');
    expect(links[0]!.textContent).toBe('설계 문서');
    expect(links[0]!.title).toBe('설계 문서');
    expect(container.textContent).toContain('없는 것');
  });

  it('⭐실재 집합을 모르는 소비처(값 없음)는 어떤 경로에서도 링크 0 — «[[…]]» · 마크다운 span · HTML span · 임베드 둘', async () => {
    const md = '[[onboarding]] <span data-type="wikiLink" data-slug="design-doc">설계</span>\n\n<div data-page-embed data-title="회의록" data-slug="onboarding"></div>\n';
    await renderDoc(md, { wikiLinkTargets: null });
    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(container.textContent).toContain('[[onboarding]]');
    await renderDoc('<p><span data-type="wikiLink" data-title="설계" data-slug="design-doc">설계</span></p><div data-page-embed data-title="회의록" data-slug="onboarding"></div>', { format: 'html', wikiLinkTargets: null });
    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(container.textContent).toContain('회의록');
  });

  // PO 13:44Z — 이름 바꾼 문서를 가리키는 옛 slug도 열리는 문서다: 링크 · 주소는 **지금 slug**(옛 주소 → alias 해소 → router.replace 왕복 0 ·
  // AC4 «Doc 요청 1»). 모든 경로(«[[…]]» · 마크다운 span · HTML span · 임베드 둘)가 같다.
  it('⭐옛 이름(alias)으로 적힌 위키 링크 · span · 임베드 — 링크이고 주소는 지금 slug', async () => {
    await renderDoc('[[old-design]] · [[old-design|설계]] · <span data-type="wikiLink" data-slug="old-design" data-title="설계">설계</span>\n\n<div data-page-embed data-title="설계" data-slug="old-design"></div>\n');
    expect(docLinks().map((a) => a.getAttribute('href'))).toEqual(Array(4).fill('/ws-1/proj-b/docs/design-doc'));
    expect(docLinks().map((a) => a.getAttribute('data-doc-internal-link'))).toEqual(Array(4).fill('design-doc'));
    expect(docLinks().slice(0, 2).map((a) => a.textContent)).toEqual(['old-design', '설계']);
    await renderDoc('<p><span data-type="wikiLink" data-title="설계" data-slug="old-design">설계</span></p><div data-page-embed data-title="설계" data-slug="old-design"></div>', { format: 'html' });
    expect(docLinks().map((a) => a.getAttribute('href'))).toEqual(['/ws-1/proj-b/docs/design-doc', '/ws-1/proj-b/docs/design-doc']);
    const link = docLinks()[0]!;
    expect(click(link)).toBe(false);
    expect(nav.push).toHaveBeenLastCalledWith('/ws-1/proj-b/docs/design-doc');
  });

  // story #4316 — alias로 옮겨 간 문서의 임베드 카드: 경로 줄도 href와 같은 지금 slug(옛 `/old-design`을 보이면 링크와 다른 말).
  it('⭐alias 임베드 카드의 경로 줄 = 지금 slug(href와 같음) · 옛 slug 0(마크다운 · HTML)', async () => {
    for (const format of ['markdown', 'html'] as const) {
      await renderDoc('<div data-page-embed data-title="설계" data-slug="old-design"></div>\n', { format });
      const link = container.querySelector('[data-page-embed] a')!;
      expect(link.getAttribute('href'), format).toBe('/ws-1/proj-b/docs/design-doc');
      expect(link.textContent, format).toContain('/design-doc');
      expect(link.textContent, format).not.toContain('old-design');
    }
  });

  it('HTML 포맷도 같은 규칙 — 실재 밖 위키 링크는 글자 그대로 · 실재 밖 임베드는 비활성 카드', async () => {
    await renderDoc(
      '<p><span data-type="wikiLink" data-title="설계" data-slug="design-doc">설계</span> <span data-type="wikiLink" data-title="없음" data-slug="gone-doc">없음</span></p>'
      + '<div data-page-embed data-title="회의록" data-slug="onboarding"></div><div data-page-embed data-title="지운 문서" data-slug="gone-doc"></div>',
      { format: 'html' },
    );
    expect(docLinks().map((a) => a.getAttribute('href'))).toEqual(['/ws-1/proj-b/docs/design-doc', '/ws-1/proj-b/docs/onboarding']);
    expect(container.textContent).toContain('없음');
    expect(container.textContent).toContain('지운 문서');
  });

  // 유나 4673 판 (2) — 열리는 문서로 안 풀린 임베드가 작동하는 링크 카드와 같은 모양 · `/slug`를 보이면 안 된다: 에디터 임베드 오류 상태처럼 «문서를 찾을 수 없어요» + 흐린 제목.
  it('⭐안 풀린 임베드(없는 · 지운 문서) — «문서를 찾을 수 없어요» + 흐린 제목 · `/slug` 0 · 링크 0(마크다운 · HTML)', async () => {
    for (const format of ['markdown', 'html'] as const) {
      await renderDoc('<div data-page-embed data-title="지운 문서" data-slug="gone-doc"></div>\n', { format });
      const card = container.querySelector('[data-page-embed]')!;
      expect(card.getAttribute('data-embed-state'), format).toBe('not-found');
      expect(card.textContent).toContain('문서를 찾을 수 없어요');
      expect(card.textContent).toContain('지운 문서');
      expect(card.textContent).not.toContain('/gone-doc');
      expect(card.querySelector('a')).toBeNull();
    }
    // 공개 보기는 예전 그대로(제목 카드 · 비활성) — 없음 판정을 공개 보기에 드러내지 않는다.
    await renderDoc('<div data-page-embed data-title="회의록" data-slug="gone-doc"></div>\n', { publicMode: true });
    expect(container.querySelector('[data-page-embed]')!.getAttribute('data-embed-state')).toBeNull();
  });

  it('⭐마크다운 문서 링크도 본문 글자 크기 · 줄바꿈 상속(상자 아님) · 링크 쪽 더 구체적인 선택자 색(마크다운 · HTML 두 경로)', async () => {
    for (const [md, format] of [
      ['[[onboarding]] <span data-type="wikiLink" data-slug="design-doc">설계</span>', 'markdown'],
      ['<p><span data-type="wikiLink" data-title="설계" data-slug="design-doc">설계</span></p>', 'html'],
    ] as const) {
      await renderDoc(md, { format });
      expect(docLinks().length, format).toBeGreaterThan(0);
      for (const link of docLinks()) {
        for (const cls of ['inline-flex', 'text-sm', 'px-1']) expect(link.classList.contains(cls), `${format} ${cls}`).toBe(false);
        expect(link.classList.contains('[&[data-doc-internal-link]]:text-foreground'), format).toBe(true);
        expect(link.hasAttribute('data-doc-internal-link'), format).toBe(true);
      }
    }
  });

  // PO 14:00Z — XSS 표: data: URL · 따옴표 든 속성 · 태그 든 제목. 어느 경로에서도 스크립트 실행 경로 0 · 문서 링크 0(대응 밖).
  it.each([
    ['마크다운 링크 data: URL', '[x](data:text/html,<script>alert(1)</script>)'],
    ['raw a 표지 + data: href', '<a data-doc-internal-link="design-doc" href="data:text/html,x">가짜</a>'],
    ['«[[…]]» 안 따옴표로 속성 탈출 시도', '[[design-doc" onmouseover="alert(1)]]'],
    ['span data-slug 안 따옴표', '<span data-type="wikiLink" data-slug=\'design-doc" onclick="alert(1)\'>설계</span>'],
    ['span data-title에 태그', '<span data-type="wikiLink" data-slug="design-doc" data-title="<img src=x onerror=alert(1)>">설계</span>'],
  ] as const)('⭐XSS — %s', async (_name, md) => {
    await renderDoc(md);
    // 글자(텍스트 노드 · 속성 값)로 남는 건 무해 — 실행 경로(요소 · 이벤트 속성 · 스킴)만 0이어야 한다.
    expect(container.querySelectorAll('[onmouseover],[onclick],[onerror],script,img,iframe').length).toBe(0);
    for (const a of container.querySelectorAll('a')) expect(a.getAttribute('href') ?? '').not.toMatch(/^\s*(javascript|data):/i);
  });

  it('⭐XSS — HTML 포맷 임베드 · 없음 카드 제목의 태그는 글자로(escape)', async () => {
    await renderDoc('<div data-page-embed data-title="<img src=x onerror=alert(1)>" data-slug="gone-doc"></div><div data-page-embed data-title="<b>굵게</b>" data-slug="design-doc"></div>', { format: 'html' });
    expect(container.querySelectorAll('img,b,[onerror]').length).toBe(0);
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('⭐publicMode — «[[…]]» · 에디터 span 모두 평문 · 이동 0', async () => {
    await renderDoc('[[onboarding]] <span data-type="wikiLink" data-slug="design-doc">설계</span>', { publicMode: true });
    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(container.textContent).toContain('onboarding');
    expect(container.textContent).toContain('설계');
  });

  it('⭐XSS 경계 — span의 on* · style은 여전히 걸러지고, raw HTML이 문서 링크 표지를 흉내 내도 다른 주소로 가는 클라이언트 이동은 안 생김', async () => {
    await renderDoc(
      '<span data-type="wikiLink" data-slug="design-doc" onmouseover="alert(1)" style="color:red">설계</span> '
      + '<a data-doc-internal-link="design-doc" href="https://evil.test/x">가짜</a> '
      + '<a data-doc-internal-link="design-doc" href="javascript:alert(1)">가짜2</a>',
    );
    const html = container.innerHTML;
    expect(html).not.toContain('onmouseover');
    expect(html).not.toContain('color:red');
    expect(html).not.toContain('javascript:');
    // story #4316 — 흉내 낸 표지(렌더러 nonce 없음)는 믿지 않는다: 글쓴이가 적은 보통 외부 링크로 그려지고(마크다운 `[x](https://…)`와 같음)
    // 표지 속성 · 문서 링크 모양 · 클라이언트 이동은 없다. 문서 링크는 진짜 위키 span 하나뿐.
    const forged = container.querySelector('a[href="https://evil.test/x"]');
    expect(forged, '보통 링크로 그려짐').not.toBeNull();
    expect(forged!.hasAttribute('data-doc-internal-link')).toBe(false);
    expect(docLinks().map((a) => a.getAttribute('href'))).toEqual(['/ws-1/proj-b/docs/design-doc']);
  });
});
