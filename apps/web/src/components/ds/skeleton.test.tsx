// @vitest-environment jsdom
// UI-3(a9d56577) — ds Skeleton 회귀가드: 새 토큰 막대 · 움직임 줄이기 · 장식(aria-hidden) · 글 줄 높이 자리 · 묶음이 한 번만 말함.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Skeleton, SkeletonGroup } from './skeleton';

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
const sk = () => container.querySelector('[data-slot="ds-skeleton"]') as HTMLElement;

describe('ds Skeleton', () => {
  it('⭐막대는 surface-high이고 숨쉬기는 motion-safe로만(움직임 줄이기면 멈춘다)', async () => {
    await render(<Skeleton className="h-8 w-24" />);
    expect(sk().className).toMatch(/(^|\s)bg-ds-surface-high(\s|$)/);
    expect(sk().className).toContain('motion-safe:animate-ds-pulse');
    expect(sk().className).not.toMatch(/(^|\s)animate-ds-pulse(\s|$)/);
  });

  it('⭐막대는 장식이다(aria-hidden) — 읽히는 말은 묶음이 한 번만', async () => {
    await render(<SkeletonGroup label="불러오는 중"><Skeleton /><Skeleton variant="text" /></SkeletonGroup>);
    for (const el of container.querySelectorAll('[data-slot="ds-skeleton"]')) expect(el.getAttribute('aria-hidden')).toBe('true');
    const g = container.querySelector('[data-slot="ds-skeleton-group"]') as HTMLElement;
    expect(g.getAttribute('role')).toBe('status');
    expect(g.getAttribute('aria-busy')).toBe('true');
    expect(g.getAttribute('aria-label')).toBe('불러오는 중');
  });

  it('변형: 사각 = 모서리 4 · 원 = 정사각 + 둥근 · 글 = 줄 높이 자리', async () => {
    await render(<Skeleton variant="rect" />);
    expect(sk().className).toContain('rounded-ds-control');
    await render(<Skeleton variant="circle" className="size-10" />);
    expect(sk().className).toContain('rounded-full');
    expect(sk().className).toContain('aspect-square');
  });

  it('⭐글 변형의 자리 높이는 그 글 크기의 줄 높이다(12/16 · 13/20 · 14/20 · 18/24) · 막대는 안쪽 가운데만 칠한다', async () => {
    const want: Record<string, string> = { small: 'h-4', body: 'h-5', 'card-title': 'h-5', title: 'h-6' };
    for (const [size, h] of Object.entries(want)) {
      await render(<Skeleton variant="text" size={size as never} />);
      expect(sk().className, size).toMatch(new RegExp(`(^|\\s)${h}(\\s|$)`));
      expect(sk().className, size).toContain('bg-clip-content');
    }
    // 막대는 자리 안 가운데만 — 위아래 여백(padding)이 있어야 한다(없으면 막대가 줄 상자 전체를 칠한다).
    const pad: Record<string, string> = { small: 'py-[3px]', body: 'py-1', 'card-title': 'py-1', title: 'py-1.5' };
    for (const [size, p] of Object.entries(pad)) {
      await render(<Skeleton variant="text" size={size as never} />);
      expect(sk().className.split(/\s+/), size).toContain(p);
    }
  });

  it('⭐호출부가 접근성 속성을 덮어쓰지 못한다 — 막대는 늘 aria-hidden, 묶음은 늘 role=status · aria-busy · 이름', async () => {
    const hostile = { 'aria-hidden': false, role: 'img', 'aria-live': 'assertive', 'aria-busy': false } as Record<string, unknown>;
    await render(<Skeleton {...hostile} />);
    expect(sk().getAttribute('aria-hidden')).toBe('true');
    expect(sk().getAttribute('role')).toBeNull();
    expect(sk().getAttribute('aria-live')).toBeNull();
    await render(<SkeletonGroup label="불러오는 중" {...hostile}><Skeleton /></SkeletonGroup>);
    const g = container.querySelector('[data-slot="ds-skeleton-group"]') as HTMLElement;
    expect(g.getAttribute('role')).toBe('status');
    expect(g.getAttribute('aria-busy')).toBe('true');
    expect(g.getAttribute('aria-label')).toBe('불러오는 중');
    expect(g.getAttribute('aria-live')).toBeNull();
    expect(g.getAttribute('aria-hidden')).toBeNull();
  });

  it('span으로 쓰면 인라인(문장 안) · 호출부 className이 실린다', async () => {
    await render(<p><Skeleton as="span" variant="text" className="w-28" /></p>);
    const el = container.querySelector('span[data-slot="ds-skeleton"]') as HTMLElement;
    expect(el.className).toContain('inline-block');
    expect(el.className).toContain('w-28');
    expect(container.querySelector('p div')).toBeNull();
  });
});
