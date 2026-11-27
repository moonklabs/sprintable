// @vitest-environment jsdom
//
// story #2683(모바일 IA S3) — useIsTablet()이 768~1023 문턱을 정확히 가르는지 잰다. TopBar의
// 새 GNB 트리거(Sheet GNB 폰 폐기·태블릿 존치, doc §2.6①)가 이 훅 하나에 전적으로 의존하므로
// 경계값(767/768/1023/1024)에서 틀리면 그 즉시 폰에 문이 새로 생기거나 태블릿에서 문이
// 사라진다.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { useIsTablet, useWidthClass } from './use-mobile';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function stubViewport(width: number) {
  vi.stubGlobal('innerWidth', width);
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

function Probe() {
  const isTablet = useIsTablet();
  return <span data-testid="result">{String(isTablet)}</span>;
}

async function readResult(width: number): Promise<string> {
  stubViewport(width);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => { root.render(<Probe />); });
  const text = container.querySelector('[data-testid="result"]')?.textContent ?? '';
  await act(async () => { root.unmount(); });
  container.remove();
  return text;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useIsTablet — story #2683 768~1023 경계', () => {
  it('767px(폰)는 false', async () => {
    expect(await readResult(767)).toBe('false');
  });

  it('768px(태블릿 하한)는 true', async () => {
    expect(await readResult(768)).toBe('true');
  });

  it('1023px(태블릿 상한)는 true', async () => {
    expect(await readResult(1023)).toBe('true');
  });

  it('1024px(데스크톱, MOBILE_BREAKPOINT)는 false', async () => {
    expect(await readResult(1024)).toBe('false');
  });

  it('375px(일반 폰 폭)는 false', async () => {
    expect(await readResult(375)).toBe('false');
  });
});

// story 5031 (C1 step 5a · codex round 1) — the width's third answer. The server (and React's hydrating render) cannot know the window: `unknown`. A client says `below-lg` at 1023 and `lg-up` at 1024 (the boundary), and follows a resize.
describe('useWidthClass — unknown · below-lg · lg-up (story 5031)', () => {
  function WidthProbe() { return <span data-testid="w">{useWidthClass()}</span>; }
  function follow(initial: number) {
    const listeners = new Set<() => void>();
    const state = { width: initial };
    vi.stubGlobal('matchMedia', (q: string) => ({ get matches() { return state.width <= Number(/max-width:\s*(\d+)px/.exec(q)![1]); }, addEventListener: (_: string, l: () => void) => listeners.add(l), removeEventListener: (_: string, l: () => void) => listeners.delete(l) }));
    return { set: (w: number) => { state.width = w; for (const l of [...listeners]) l(); } };
  }
  it('⭐the server render says «unknown» (never «lg-up» for a phone that is still loading)', () => {
    expect(renderToString(<WidthProbe />)).toContain('unknown');
  });
  it('⭐a client: 1023 → below-lg · 1024 → lg-up · and it follows a resize across the boundary', async () => {
    const w = follow(1023);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(<WidthProbe />); });
    expect(container.textContent).toBe('below-lg');
    await act(async () => { w.set(1024); });
    expect(container.textContent).toBe('lg-up');
    await act(async () => { w.set(1023); });
    expect(container.textContent).toBe('below-lg');
    await act(async () => { root.unmount(); });
    container.remove();
  });
});
