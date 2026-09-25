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

const EXISTING = ['design-doc', 'onboarding'];

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  nav.push.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

async function renderDoc(content: string, opts: { format?: 'html' | 'markdown'; publicMode?: boolean; wikiLinkSlugs?: string[] | null } = {}) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <DocContentRenderer
          content={content}
          contentFormat={opts.format ?? 'markdown'}
          publicMode={opts.publicMode}
          untitledEmbedLabel="제목 없음"
          wikiLinkSlugs={opts.wikiLinkSlugs === undefined ? EXISTING : opts.wikiLinkSlugs}
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
    await renderDoc(md, { wikiLinkSlugs: null });
    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(container.textContent).toContain('[[onboarding]]');
    await renderDoc('<p><span data-type="wikiLink" data-title="설계" data-slug="design-doc">설계</span></p><div data-page-embed data-title="회의록" data-slug="onboarding"></div>', { format: 'html', wikiLinkSlugs: null });
    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(container.textContent).toContain('회의록');
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
    expect(html).not.toContain('evil.test');
    expect(docLinks().map((a) => a.getAttribute('href'))).toEqual(['/ws-1/proj-b/docs/design-doc']);
  });
});
