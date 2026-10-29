// @vitest-environment jsdom
//
// [SID:4299] 탭 프리패치는 첫 화면 뒤로 — 기본 prefetch Link 여섯이 보이자마자 tree + data를 보내 기기 콜드 정착을 +300ms 밀었다(AC3 판).
// 약속: (1) 탭 Link는 자동 프리패치 끔(prefetch={false}) (2) 첫 화면이 조용해진 뒤 지금 탭 이웃 둘만 router.prefetch
// (3) 누르려는 기색(pointerenter · focus · touchstart) 때 그 탭 router.prefetch (4) 탭이 바뀌면 옛 예약을 풀고 새 이웃으로.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const h = vi.hoisted(() => ({
  prefetch: vi.fn(),
  linkProps: [] as Array<{ href: string; prefetch: unknown }>,
  quiet: [] as Array<{ run: () => void; cancel: ReturnType<typeof vi.fn> }>,
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ ws: 'my-ws', proj: 'my-proj' }),
  useRouter: () => ({ prefetch: h.prefetch, push: vi.fn(), replace: vi.fn() }),
}));

// 실제 Link의 prefetch 값은 DOM에 안 남는다 — 받은 prop을 적어 두는 얇은 가짜(나머지 prop은 <a>로 그대로).
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: React.forwardRef<HTMLAnchorElement, Record<string, unknown>>(function LinkStub({ href, prefetch, children, ...rest }, ref) {
      h.linkProps.push({ href: String(href), prefetch });
      return React.createElement('a', { ...rest, href: String(href), ref }, children as React.ReactNode);
    }),
  };
});

vi.mock('@/lib/first-screen-quiet', () => ({
  whenFirstScreenQuiet: (run: () => void) => {
    const cancel = vi.fn();
    h.quiet.push({ run, cancel });
    return cancel;
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  h.prefetch.mockReset();
  h.linkProps.length = 0;
  h.quiet.length = 0;
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

async function render(active: 'workList' | 'board' | 'sprints' | 'epic' | 'retro' | 'hypothesis') {
  const { WorkspaceFrameTabs } = await import('./workspace-frame-tabs');
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <WorkspaceFrameTabs active={active} />
      </NextIntlClientProvider>,
    );
  });
}

const href = (path: string) => `/my-ws/my-proj/${path}`;

describe('[SID:4299] 탭 프리패치 — 첫 화면 뒤 · 이웃 둘 · 누르려는 기색', () => {
  it('⭐탭 Link 여섯 모두 자동 프리패치를 끈다(prefetch={false})', async () => {
    await render('board');
    const last6 = h.linkProps.slice(-6);
    expect(last6.map((p) => p.href)).toEqual(['work-list', 'flow', 'sprints', 'epics', 'retro', 'hypotheses'].map(href));
    expect(last6.every((p) => p.prefetch === false)).toBe(true);
  });

  it('⭐그릴 때는 router.prefetch 0 — 첫 화면이 조용해진 뒤 지금 탭 이웃 둘만(보드 → 목록 · 스프린트)', async () => {
    await render('board');
    expect(h.prefetch).not.toHaveBeenCalled();
    expect(h.quiet).toHaveLength(1);
    h.quiet[0]!.run();
    expect(h.prefetch.mock.calls.map(([u]) => u)).toEqual([href('work-list'), href('sprints')]);
  });

  it('끝 탭은 이웃 하나(목록 → 보드 · 가설 → 회고)', async () => {
    await render('workList');
    h.quiet.at(-1)!.run();
    expect(h.prefetch.mock.calls.map(([u]) => u)).toEqual([href('flow')]);
    h.prefetch.mockReset();
    await render('hypothesis');
    h.quiet.at(-1)!.run();
    expect(h.prefetch.mock.calls.map(([u]) => u)).toEqual([href('retro')]);
  });

  it.each([
    ['pointerenter', (el: Element) => el.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }))],
    ['focus', (el: Element) => (el as HTMLElement).focus()],
    ['touchstart', (el: Element) => el.dispatchEvent(new Event('touchstart', { bubbles: true }))],
  ])('누르려는 기색(%s) 때 그 탭을 router.prefetch — 이웃 아닌 «가설»도', async (_label, fire) => {
    await render('board');
    const tab = [...container.querySelectorAll('[role="tab"]')].find((t) => t.textContent === '가설')!;
    await act(async () => { fire(tab); });
    expect(h.prefetch).toHaveBeenCalledWith(href('hypotheses'));
  });

  it('탭이 바뀌면 옛 예약을 풀고 새 이웃으로 다시 건다', async () => {
    await render('board');
    const first = h.quiet[0]!;
    await render('epic');
    expect(first.cancel).toHaveBeenCalled();
    h.quiet.at(-1)!.run();
    expect(h.prefetch.mock.calls.map(([u]) => u)).toEqual([href('sprints'), href('retro')]);
  });
});
