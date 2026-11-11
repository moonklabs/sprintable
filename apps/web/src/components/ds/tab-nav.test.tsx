// UI-3(a9d56577) — ds TabNav 회귀가드: nav 랜드마크 이름 · aria-current · asChild 링크(프리패치 핸들러 보존) · 켜진 탭 스크롤 · 모양.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});
async function render(n: ReactNode) { await act(async () => { root.render(n); }); }
import { TabNav, TabNavLink } from './tab-nav';

const links = () => [...container.querySelectorAll('a')] as HTMLAnchorElement[];

function Strip({ active }: { active: string }) {
  return (
    <TabNav aria-label="팀">
      {['members', 'agents', 'runs'].map((k) => (
        <TabNavLink key={k} asChild active={active === k}>
          <a href={`https://example.com/${k}`} data-k={k}>{k}</a>
        </TabNavLink>
      ))}
    </TabNav>
  );
}

describe('ds TabNav', () => {
  it('⭐nav 랜드마크에 이름이 있고 role=tablist가 아니다(링크에 role=tab을 얹지 않는다)', async () => {
    await render(<Strip active="agents" />);
    const nav = container.querySelector('nav')!;
    expect(nav.getAttribute('aria-label')).toBe('팀');
    expect(container.querySelector('[role="tablist"], [role="tab"]')).toBeNull();
  });

  it('⭐켜진 칸만 aria-current=page, 밑줄 + 굵기 · 꺼진 칸은 ink-3', async () => {
    await render(<Strip active="agents" />);
    expect(links().map((a) => a.getAttribute('aria-current'))).toEqual([null, 'page', null]);
    expect(links()[1]!.className).toContain('border-ds-action');
    expect(links()[1]!.className).toContain('font-semibold');
    expect(links()[1]!.className).toContain('text-ds-action-text');
    expect(links()[0]!.className).toMatch(/(^|\s)text-ds-ink-3(\s|$)/);
    expect(links()[0]!.className).not.toContain('border-ds-action');
  });

  it('asChild: 자식 링크의 href · data 속성이 그대로 살고 모양이 입혀진다', async () => {
    await render(<Strip active="members" />);
    expect(links()[0]!.getAttribute('href')).toBe('https://example.com/members');
    expect(links()[0]!.getAttribute('data-k')).toBe('members');
    expect(links()[0]!.getAttribute('data-slot')).toBe('ds-tab-nav-link');
  });

  it('프리패치 같은 핸들러(onPointerEnter 등)가 자식 링크를 거쳐 그대로 불린다', async () => {
    const onEnter = vi.fn();
    await render(<TabNav aria-label="x"><TabNavLink asChild><a href="https://example.com/a" onPointerEnter={onEnter}>a</a></TabNavLink></TabNav>);
    // React의 onPointerEnter는 pointerover로 흉내 낸다 — 바깥에서 들어오는 pointerover 하나.
    await act(async () => { links()[0]!.dispatchEvent(new MouseEvent('pointerover', { bubbles: true, relatedTarget: document.body })); });
    expect(onEnter).toHaveBeenCalledTimes(1);
  });

  // jsdom은 레이아웃이 없다 — 줄과 링크의 사각형을 직접 준다.
  function rect(left: number, right: number): DOMRect {
    return { left, right, top: 0, bottom: 32, width: right - left, height: 32, x: left, y: 0, toJSON: () => ({}) } as DOMRect;
  }
  function stripFrame(linkRects: Record<string, [number, number]>, stripRect: [number, number]) {
    const nav = container.querySelector('nav') as HTMLElement;
    nav.getBoundingClientRect = () => rect(stripRect[0], stripRect[1]);
    for (const a of links()) {
      const r = linkRects[a.getAttribute('data-k')!];
      if (r) a.getBoundingClientRect = () => rect(r[0], r[1]);
    }
    return nav;
  }

  it('⭐켜진 탭이 줄 오른쪽 밖이면 줄의 scrollLeft만 당긴다 — 페이지(scrollIntoView · window 스크롤)는 안 건드린다', async () => {
    const spy = vi.fn();
    Element.prototype.scrollIntoView = spy;
    const winSpy = vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
    await render(<Strip active="members" />);
    const nav = stripFrame({ runs: [380, 460] }, [0, 300]);
    nav.scrollLeft = 10;
    await render(<Strip active="runs" />);
    // 링크 오른쪽 460 − (줄 오른쪽 300 − 흐림 24) = 184만큼 더 당긴다
    expect(nav.scrollLeft).toBe(10 + 184);
    expect(spy).not.toHaveBeenCalled();
    expect(winSpy).not.toHaveBeenCalled();
  });

  it('⭐켜진 탭이 줄 왼쪽 밖이면 왼쪽으로 당긴다', async () => {
    await render(<Strip active="agents" />);
    const nav = stripFrame({ members: [-60, 20] }, [0, 300]);
    nav.scrollLeft = 100;
    await render(<Strip active="members" />);
    expect(nav.scrollLeft).toBe(100 - 60);
  });

  it('이미 보이면 줄을 움직이지 않는다 · 켜짐이 안 바뀌면(같은 탭 다시 그림) 건드리지 않는다', async () => {
    await render(<Strip active="members" />);
    const nav = stripFrame({ agents: [40, 120] }, [0, 300]);
    nav.scrollLeft = 7;
    await render(<Strip active="agents" />);
    expect(nav.scrollLeft).toBe(7);
    nav.scrollLeft = 50;
    await render(<Strip active="agents" />);
    expect(nav.scrollLeft).toBe(50);
  });

  it('줄은 가로 스크롤 · 아래 선은 바깥 래퍼 · 폰 누름 44', async () => {
    await render(<Strip active="agents" />);
    const nav = container.querySelector('nav')!;
    expect(nav.className).toContain('overflow-x-auto');
    expect(nav.parentElement!.className).toContain('border-b');
    expect(links()[0]!.className).toContain('touch:min-h-ds-touch');
    expect(links()[0]!.className).toContain('focus-visible:ring-inset');
    expect(links()[0]!.className).toMatch(/(^|\s)-mb-px(\s|$)/);
  });

  it('⭐바깥에서 준 ref도 받고 scrollIntoView도 여전히 된다(ref 합성)', async () => {
    let got: HTMLAnchorElement | null = null;
    await render(<TabNav aria-label="x"><TabNavLink asChild ref={(n) => { got = n; }}><a href="https://example.com/a">a</a></TabNavLink></TabNav>);
    expect(got).toBe(links()[0]);
    // 안쪽 ref도 살아 있다 — 켜진 탭을 줄 안으로 당기는 일이 된다(바깥 ref가 안쪽을 덮어쓰면 안 된다).
    const nav = container.querySelector('nav') as HTMLElement;
    nav.getBoundingClientRect = () => rect(0, 300);
    links()[0]!.getBoundingClientRect = () => rect(500, 560);
    nav.scrollLeft = 0;
    await render(<TabNav aria-label="x"><TabNavLink asChild active ref={(n) => { got = n; }}><a href="https://example.com/a">a</a></TabNavLink></TabNav>);
    expect(nav.scrollLeft).toBeGreaterThan(0);
  });

  it('⭐asChild에 Fragment · 글을 주면 그리지 않는다(모양 · 접근성을 새게 하지 않는다)', async () => {
    const frag = (<><a href="https://example.com/a">a</a></>) as never;
    await render(<TabNav aria-label="x"><TabNavLink asChild>{frag}</TabNavLink></TabNav>);
    expect(container.querySelector('a')).toBeNull();
    await render(<TabNav aria-label="x"><TabNavLink asChild>{'글' as never}</TabNavLink></TabNav>);
    expect(container.querySelector('[data-slot="ds-tab-nav-link"]')).toBeNull();
  });

  it('일반 a로도 쓴다(asChild 없이)', async () => {
    await render(<TabNav aria-label="x"><TabNavLink href="https://example.com/z" active>z</TabNavLink></TabNav>);
    expect(links()[0]!.getAttribute('href')).toBe('https://example.com/z');
    expect(links()[0]!.getAttribute('aria-current')).toBe('page');
  });
});
