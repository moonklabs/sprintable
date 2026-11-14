// 4928 — ds DataText 회귀가드: 글 속 데이터 조각만 고정폭 + 숫자 칸 맞춤.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DataText } from './data-text';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

describe('ds DataText', () => {
  it('⭐고정폭 + tabular-nums + 손잡이(data-slot) — 호출처가 데이터 조각에 명시한다', async () => {
    await act(async () => { root.render(<DataText data-testid="x">10-02 10:44</DataText>); });
    const el = container.querySelector('[data-slot="ds-data-text"]') as HTMLElement;
    expect(el.tagName).toBe('SPAN');
    expect(el.className).toContain('font-mono');
    expect(el.className).toContain('tabular-nums');
    expect(el.getAttribute('data-testid')).toBe('x');
    expect(el.textContent).toBe('10-02 10:44');
  });

  it('className을 덧붙여도 고정폭은 남는다', async () => {
    await act(async () => { root.render(<DataText className="text-ds-ink-3">a@b.co</DataText>); });
    const el = container.querySelector('[data-slot="ds-data-text"]') as HTMLElement;
    expect(el.className).toContain('font-mono');
    expect(el.className).toContain('text-ds-ink-3');
  });
});
