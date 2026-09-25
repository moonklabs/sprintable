// @vitest-environment jsdom
// story #4309 — 본문의 문서 링크(위키 링크 · 페이지 임베드)는 진짜 `<a href>`(키보드 초점 · Enter · 새 탭)이고, 목적지는 처음부터
// 이 탭 주소의 `/{ws}/{proj}/docs/{slug}` · 보통 클릭은 클라이언트 라우터(`window.location` 전체 새로고침 + 서버 307 없음).
// jsdom은 Tab 순서 · Enter→click을 흉내 내지 않는다 — 그 둘은 브라우저가 `<a href>`에 보장하는 동작이라, 여기선 «진짜 링크인지»
// (a · href · 탭 순서 안)와 클릭 경로를 잰다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { CURRENT_PROJECT_COOKIE } from '@/lib/auth-helpers';

const nav = vi.hoisted(() => ({ params: { ws: 'ws-1', proj: 'proj-b' } as Record<string, string>, push: vi.fn() }));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useParams: () => nav.params,
  useRouter: () => ({ push: nav.push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('@/hooks/use-flat-href', () => ({ useFlatHref: () => (h: string) => `${h}${h.includes('?') ? '&' : '?'}p=P` }));

import { DocContentRenderer } from './doc-content-renderer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WIKI = '<p>앞 <span data-type="wikiLink" data-doc-id="d-1" data-title="설계 문서" data-slug="design-doc">설계 문서</span> 뒤</p>';
const EMBED = '<div data-page-embed data-doc-id="d-2" data-title="회의록" data-icon="📄" data-slug="meeting-notes"></div>';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  nav.params = { ws: 'ws-1', proj: 'proj-b' };
  nav.push.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

// story #4313 — 링크는 위키 링크 대응(문서 상세 응답 `wiki_link_targets` · 적힌 slug → 지금 slug)에 든 것만. 4309 테스트의 문서는 다 살아 있는 문서로 둔다.
const EXISTING: Record<string, string> = { 'design-doc': 'design-doc', 'meeting-notes': 'meeting-notes', 'untitled-1': 'untitled-1' };

async function renderDoc(content: string, opts: { format?: 'html' | 'markdown'; publicMode?: boolean; wikiLinkTargets?: Record<string, string> | null } = {}) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <DocContentRenderer content={content} contentFormat={opts.format ?? 'html'} publicMode={opts.publicMode} untitledEmbedLabel="제목 없음" embedNotFoundLabel="문서를 찾을 수 없어요" wikiLinkTargets={opts.wikiLinkTargets === undefined ? EXISTING : opts.wikiLinkTargets} />
      </NextIntlClientProvider>,
    );
  });
}

function click(el: Element, init: MouseEventInit = {}): boolean {
  let notPrevented = true;
  act(() => { notPrevented = el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init })); });
  return notPrevented;
}

/** 접근 가능한 이름 — aria-label이 있으면 그것, 없으면 글자(이 두 링크에 aria-labelledby는 없다). */
function accessibleName(el: Element): string {
  return (el.getAttribute('aria-label') ?? el.textContent ?? '').trim();
}

describe('DocContentRenderer — 본문 문서 링크(story #4309)', () => {
  it('⭐위키 링크 = 진짜 링크: `<a href="/{ws}/{proj}/docs/{slug}">` · 탭 순서 안 · 이름 = 문서 제목', async () => {
    await renderDoc(WIKI);
    const link = container.querySelector('[data-type="wikiLink"] a');
    expect(link, '위키 링크가 <a>로').toBeInstanceOf(HTMLAnchorElement);
    expect(link!.getAttribute('href')).toBe('/ws-1/proj-b/docs/design-doc');
    expect((link as HTMLAnchorElement).tabIndex, 'Tab이 닿는다').toBe(0);
    expect(accessibleName(link!)).toBe('설계 문서');
  });

  it('⭐페이지 임베드 = 카드 전체가 링크 하나 · 이름 = 문서 제목(경로 줄은 이름에 안 섞임)', async () => {
    for (const format of ['html', 'markdown'] as const) {
      await renderDoc(EMBED, { format });
      const links = container.querySelectorAll('[data-page-embed] a');
      expect(links, `${format}: 카드 안 링크 하나`).toHaveLength(1);
      const link = links[0] as HTMLAnchorElement;
      expect(link.getAttribute('href')).toBe('/ws-1/proj-b/docs/meeting-notes');
      expect(link.tabIndex).toBe(0);
      expect(accessibleName(link)).toBe('회의록');
      expect(link.textContent, '카드 모양(제목 · 경로 줄)은 그대로').toContain('/meeting-notes');
    }
  });

  // story #4313(유나 4673 판 · PO 14:00Z) — 위키 링크: (1) 16px 본문 속 14px 끊기지 않는 상자(`inline-flex text-sm px-1` · 06-23 리디자인부터) →
  // 본문 글자 크기 · 줄바꿈 상속. (2) 루트 `[&_a]` 링크 색(본문 링크 전체 · 디디 4315가 brand-soft → brand-text로 바꿈 · 여기선 안 건드림)이 선언 색을 덮던 것 →
  // 링크 자신의 쪽에서 더 구체적인 선택자(`[&[data-doc-internal-link]]:text-foreground` = (0,2,0) > 루트 `.root a` (0,1,1) · 유나 조정).
  it('⭐위키 링크는 본문 글자 크기 · 줄바꿈을 물려받고(상자 아님) 색은 링크 쪽 더 구체적인 선택자가 이긴다', async () => {
    await renderDoc(WIKI + EMBED);
    const wiki = container.querySelector('[data-type="wikiLink"] a')!;
    for (const cls of ['inline-flex', 'text-sm', 'px-1', 'py-0.5']) expect(wiki.classList.contains(cls), cls).toBe(false);
    expect(wiki.classList.contains('[&[data-doc-internal-link]]:text-foreground')).toBe(true);
    expect(wiki.hasAttribute('data-doc-internal-link'), '선택자가 걸리는 속성').toBe(true);
    expect(wiki.classList.contains('text-foreground'), '루트 (0,1,1)에 밀리는 보통 선언 아님').toBe(false);
    // 루트 링크 규칙은 이 PR이 안 건드린다(4315 몫).
    expect((container.firstElementChild as HTMLElement).className).toContain('[&_a]:text-brand-text');
  });

  // 까디르 4673 P3 — 효과가 다시 돌 때(대응이 비거나 publicMode 전환) 이미 만든 링크가 글자로 돌아가야 한다.
  it('⭐대응이 비면 · publicMode로 바뀌면 이미 만든 HTML 위키 링크가 글자로 돌아감', async () => {
    await renderDoc(WIKI);
    expect(container.querySelector('[data-type="wikiLink"] a')).not.toBeNull();
    await renderDoc(WIKI, { wikiLinkTargets: null });
    expect(container.querySelector('[data-type="wikiLink"] a'), '대응 없음').toBeNull();
    expect(container.querySelector('[data-type="wikiLink"]')!.textContent).toBe('설계 문서');
    await renderDoc(WIKI);
    expect(container.querySelector('[data-type="wikiLink"] a')).not.toBeNull();
    await renderDoc(WIKI, { publicMode: true });
    expect(container.querySelector('[data-type="wikiLink"] a'), 'publicMode').toBeNull();
    expect(container.querySelector('[data-type="wikiLink"]')!.textContent).toBe('설계 문서');
  });

  it('제목 없는 임베드의 이름 = 빈 제목 표기', async () => {
    await renderDoc('<div data-page-embed data-doc-id="d-3" data-title="" data-slug="untitled-1"></div>');
    expect(accessibleName(container.querySelector('[data-page-embed] a')!)).toBe('(제목 없음)');
  });

  it('⭐보통 클릭(Enter도 같은 click) = 클라이언트 이동 한 번 · 전체 새로고침 없음(기본 동작 막음)', async () => {
    await renderDoc(WIKI + EMBED);
    const before = window.location.href;
    const wiki = container.querySelector('[data-type="wikiLink"] a')!;
    expect(click(wiki), '기본 이동(전체 새로고침) 막음').toBe(false);
    expect(nav.push).toHaveBeenLastCalledWith('/ws-1/proj-b/docs/design-doc');
    const embed = container.querySelector('[data-page-embed] a')!;
    expect(click(embed)).toBe(false);
    expect(nav.push).toHaveBeenLastCalledWith('/ws-1/proj-b/docs/meeting-notes');
    expect(nav.push).toHaveBeenCalledTimes(2);
    expect(window.location.href, 'window.location 이동 0').toBe(before);
  });

  it('⭐⌘ · Ctrl · Shift · Alt 클릭과 가운데 클릭은 브라우저에 맡긴다(새 탭 · 새 창) — 라우터 0', async () => {
    await renderDoc(WIKI + EMBED);
    for (const sel of ['[data-type="wikiLink"] a', '[data-page-embed] a']) {
      const link = container.querySelector(sel)!;
      for (const mod of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
        expect(click(link, mod), `${sel} ${JSON.stringify(mod)} 기본 동작 유지`).toBe(true);
      }
      let auxNotPrevented = true;
      act(() => { auxNotPrevented = link.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })); });
      expect(auxNotPrevented, `${sel} 가운데 클릭(auxclick)`).toBe(true);
    }
    expect(nav.push).not.toHaveBeenCalled();
  });

  // 쿠키는 운영이 읽는 이름 · 값(`CURRENT_PROJECT_COOKIE` = 프로젝트 id · 까디르 4664 P2). flat 목적지면 proxy가 이 쿠키로 프로젝트를 고른다.
  it('두 탭 다른 프로젝트 — 목적지는 이 탭 주소의 프로젝트(proj-b) · 쿠키(다른 탭 proj-a)와 무관', async () => {
    document.cookie = `${CURRENT_PROJECT_COOKIE}=proj-a-id; path=/`;
    try {
      expect(document.cookie).toContain(`${CURRENT_PROJECT_COOKIE}=proj-a-id`);
      await renderDoc(WIKI + EMBED);
      const hrefs = [...container.querySelectorAll('a[data-doc-internal-link]')].map((a) => a.getAttribute('href') ?? '');
      expect(hrefs).toHaveLength(2);
      for (const h of hrefs) {
        expect(h.startsWith('/ws-1/proj-b/docs/')).toBe(true);
        expect(h).not.toContain('proj-a');
      }
    } finally {
      document.cookie = `${CURRENT_PROJECT_COOKIE}=; path=/; max-age=0`;
    }
  });

  it('경로에 ws/proj가 없는 자리만 flat + `?p=`(bare 아님)', async () => {
    nav.params = {};
    await renderDoc(WIKI);
    expect(container.querySelector('[data-type="wikiLink"] a')!.getAttribute('href')).toBe('/docs/design-doc?p=P');
  });

  // 부모가 다시 그려도(같은 본문) 링크 · 임베드 카드가 원문으로 지워지지 않는다 — React 19는 새 `{ __html }` 객체면 innerHTML을 다시 쓴다.
  it('⭐목적지가 바뀌면 이미 만든 링크의 href도 새로(본문 다시 조립 없이 · 다시 그려도 링크가 안 지워짐)', async () => {
    await renderDoc(WIKI + EMBED);
    const wiki = container.querySelector('[data-type="wikiLink"] a');
    nav.params = { ws: 'ws-1', proj: 'proj-c' };
    await renderDoc(WIKI + EMBED);
    expect(container.querySelector('[data-type="wikiLink"] a'), '같은 노드(다시 조립 안 함)').toBe(wiki);
    expect([...container.querySelectorAll('a[data-doc-internal-link]')].map((a) => a.getAttribute('href')))
      .toEqual(['/ws-1/proj-c/docs/design-doc', '/ws-1/proj-c/docs/meeting-notes']);
  });

  it('⭐publicMode(공개 공유 보기)는 지금처럼 비활성 평문 — 링크 0 · 이동 0', async () => {
    await renderDoc(WIKI + EMBED, { publicMode: true });
    expect(container.querySelectorAll('a')).toHaveLength(0);
    const span = container.querySelector('[data-type="wikiLink"]')!;
    expect(span.className).toBe('text-sm text-muted-foreground');
    expect(span.hasAttribute('data-slug')).toBe(false);
    const card = container.querySelector('[data-page-embed]')!;
    expect(card.textContent, '카드(제목)는 그대로 보임').toContain('회의록');
    click(span);
    click(card);
    expect(nav.push).not.toHaveBeenCalled();
  });

  it('slug 없는 위키 링크 · 임베드는 목적지가 없어 링크를 만들지 않음', async () => {
    await renderDoc('<p><span data-type="wikiLink" data-title="고아">고아</span></p><div data-page-embed data-title="고아 카드"></div>');
    expect(container.querySelectorAll('a')).toHaveLength(0);
  });
});
