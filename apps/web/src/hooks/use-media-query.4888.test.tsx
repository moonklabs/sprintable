// @vitest-environment jsdom
// story #4888(UI-5 홈) — 화면 폭 판정 훅: 쿼리에 맞는지 · 폭이 바뀌면 따라가는지 · matchMedia가 없으면 false.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useMediaQuery } from './use-media-query';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; });

function Probe({ q }: { q: string }) { return <span data-testid="v">{String(useMediaQuery(q))}</span>; }
async function mount(q: string) {
  const el = document.createElement('div'); document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(<Probe q={q} />); });
  return { el, root };
}

describe('useMediaQuery', () => {
  it('⭐쿼리에 맞으면 true · 안 맞으면 false(같은 쿼리 문자열로 묻는다)', async () => {
    const asked: string[] = [];
    vi.stubGlobal('matchMedia', (q: string) => { asked.push(q); return { matches: q === '(min-width: 1024px)', media: q, addEventListener: () => {}, removeEventListener: () => {} }; });
    expect((await mount('(min-width: 1024px)')).el.textContent).toBe('true');
    expect((await mount('(min-width: 2000px)')).el.textContent).toBe('false');
    expect(asked).toContain('(min-width: 1024px)');
  });
  it('⭐폭이 바뀌어 change가 오면 다시 그린다 · 풀리면 구독을 끊는다', async () => {
    let matches = false; let listener: (() => void) | null = null; let removed = 0;
    vi.stubGlobal('matchMedia', (q: string) => ({ get matches() { return matches; }, media: q, addEventListener: (_: string, l: () => void) => { listener = l; }, removeEventListener: () => { removed += 1; } }));
    const { el, root } = await mount('(min-width: 1024px)');
    expect(el.textContent).toBe('false');
    matches = true;
    await act(async () => { listener!(); });
    expect(el.textContent).toBe('true');
    await act(async () => { root.unmount(); });
    expect(removed).toBe(1);
  });
  it('matchMedia가 없는 환경은 false(깨지지 않는다)', async () => {
    vi.stubGlobal('matchMedia', undefined);
    expect((await mount('(min-width: 1024px)')).el.textContent).toBe('false');
  });
});
