// @vitest-environment jsdom
//
// story #2683(모바일 IA S3) — useIsTablet()이 768~1023 문턱을 정확히 가르는지 잰다. TopBar의
// 새 GNB 트리거(Sheet GNB 폰 폐기·태블릿 존치, doc §2.6①)가 이 훅 하나에 전적으로 의존하므로
// 경계값(767/768/1023/1024)에서 틀리면 그 즉시 폰에 문이 새로 생기거나 태블릿에서 문이
// 사라진다.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useIsTablet } from './use-mobile';

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
