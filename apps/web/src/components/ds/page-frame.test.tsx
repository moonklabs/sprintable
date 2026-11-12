// 4913(UI-R5) PageFrame — 폭은 셋뿐(reading 768 · wide 1152 · stream 제한 없음), 바깥 여백 · 칸 간격 한 가지, 면은 «쪽 바탕» 층.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PageFrame } from './page-frame';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

const frame = () => container.querySelector('[data-slot="ds-page-frame"]') as HTMLElement;

describe('ds PageFrame', () => {
  it('⭐기본 reading 768 · wide 1152 · stream 제한 없음 — 클래스가 표의 px과 같다', async () => {
    for (const [width, cls] of [['reading', 'max-w-[48rem]'], ['wide', 'max-w-[72rem]'], ['stream', 'max-w-none']] as const) {
      await act(async () => { root.render(<PageFrame width={width}>x</PageFrame>); });
      expect(frame().getAttribute('data-width')).toBe(width);
      expect(frame().className).toContain(cls);
    }
    await act(async () => { root.render(<PageFrame>x</PageFrame>); });
    expect(frame().getAttribute('data-width')).toBe('reading');
  });

  it('⭐자기 바탕을 칠하지 않는다(쪽 바탕은 셸 몫 — 틀이 칠하면 셸 색과 어긋난 네모가 뜬다) · 가운데 · 칸 간격 24 · 바깥 여백 폰 16 / 데스크톱 24', async () => {
    await act(async () => { root.render(<PageFrame>x</PageFrame>); });
    const cls = frame().className;
    expect(cls).not.toMatch(/(?:^|\s)bg-/);
    for (const c of ['mx-auto', 'w-full', 'flex-col', 'gap-6', 'p-4', 'sm:p-6']) expect(cls).toContain(c);
  });

  it('className을 덧붙여도 폭 클래스는 그대로고 속성이 전달된다', async () => {
    await act(async () => { root.render(<PageFrame width="wide" className="extra" data-testid="f">x</PageFrame>); });
    expect(frame().className).toContain('extra');
    expect(frame().className).toContain('max-w-[72rem]');
    expect(frame().getAttribute('data-testid')).toBe('f');
  });
});
