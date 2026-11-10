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

  it('⭐켜진 탭이 바뀌면 그 탭을 줄 안으로 가져온다(scrollIntoView nearest) · 꺼진 탭은 안 움직인다', async () => {
    const spy = vi.fn();
    Element.prototype.scrollIntoView = spy;
    await render(<Strip active="members" />);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenLastCalledWith({ block: 'nearest', inline: 'nearest' });
    await render(<Strip active="runs" />);
    expect(spy).toHaveBeenCalledTimes(2);
    await render(<Strip active="runs" />);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('줄은 가로 스크롤 · 아래 선은 바깥 래퍼 · 폰 누름 44', async () => {
    await render(<Strip active="agents" />);
    const nav = container.querySelector('nav')!;
    expect(nav.className).toContain('overflow-x-auto');
    expect(nav.parentElement!.className).toContain('border-b');
    expect(links()[0]!.className).toContain('pointer-coarse:min-h-11');
    expect(links()[0]!.className).toContain('focus-visible:ring-inset');
    expect(links()[0]!.className).toMatch(/(^|\s)-mb-px(\s|$)/);
  });

  it('⭐바깥에서 준 ref도 받고 scrollIntoView도 여전히 된다(ref 합성)', async () => {
    const spy = vi.fn();
    Element.prototype.scrollIntoView = spy;
    let got: HTMLAnchorElement | null = null;
    await render(<TabNav aria-label="x"><TabNavLink asChild active ref={(n) => { got = n; }}><a href="https://example.com/a">a</a></TabNavLink></TabNav>);
    expect(got).toBe(links()[0]);
    expect(spy).toHaveBeenCalledTimes(1);
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
