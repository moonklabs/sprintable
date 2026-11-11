// @vitest-environment jsdom
// UI-3(a9d56577) — ds PageSplit 회귀가드: 본문 + 옆 칸(16rem) 격자 · 옆 칸 이름 필수(aside 랜드마크) · 읽기 순서 본문 → 옆 칸 · 좁은 화면 자리(위/아래).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PageSplit } from './page-split';

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
const frame = () => container.querySelector('[data-slot="ds-page-split"]') as HTMLElement;
const main = () => container.querySelector('[data-slot="ds-page-split-main"]') as HTMLElement;
const aside = () => container.querySelector('[data-slot="ds-page-split-aside"]') as HTMLElement;
const has = (el: Element, c: string) => el.className.split(/\s+/).includes(c);

describe('ds PageSplit', () => {
  it('⭐본문 칸 + 옆 칸(aside 랜드마크, 이름 필수) — lg부터 두 칸(오른쪽 16rem) · 간격 16', async () => {
    await render(<PageSplit asideLabel="지금까지 고른 것" aside={<i data-testid="a" />}><b data-testid="m" /></PageSplit>);
    expect(aside().tagName).toBe('ASIDE');
    expect(aside().getAttribute('aria-label')).toBe('지금까지 고른 것');
    expect(main().querySelector('[data-testid="m"]')).not.toBeNull();
    expect(aside().querySelector('[data-testid="a"]')).not.toBeNull();
    expect(has(frame(), 'grid')).toBe(true);
    expect(has(frame(), 'gap-4')).toBe(true);
    expect(has(frame(), 'lg:grid-cols-[minmax(0,1fr)_16rem]')).toBe(true);
    expect(has(frame(), 'lg:items-start')).toBe(true);
    expect(has(main(), 'min-w-0')).toBe(true);
    expect(has(aside(), 'min-w-0')).toBe(true);
  });

  it('⭐읽기 순서(DOM)는 늘 본문 → 옆 칸 — 좁은 화면의 눈에 보이는 순서만 바뀐다', async () => {
    await render(<PageSplit asideLabel="옆" aside="A">M</PageSplit>);
    expect(frame().children[0]).toBe(main());
    expect(frame().children[1]).toBe(aside());
    expect(has(aside(), 'max-lg:order-first')).toBe(true);
    expect(frame().getAttribute('data-narrow')).toBe('above');
    await render(<PageSplit asideLabel="옆" aside="A" narrow="below">M</PageSplit>);
    expect(has(aside(), 'max-lg:order-first')).toBe(false);
    expect(frame().getAttribute('data-narrow')).toBe('below');
    expect(frame().children[0]).toBe(main());
  });

  it('호출부 className · 속성이 틀에 닿고 data-slot은 덮이지 않는다', async () => {
    await render(<PageSplit asideLabel="옆" aside="A" className="mt-4" data-testid="x" {...({ 'data-slot': 'evil' } as object)}>M</PageSplit>);
    expect(has(frame(), 'mt-4')).toBe(true);
    expect(frame().getAttribute('data-testid')).toBe('x');
    expect(frame().getAttribute('data-slot')).toBe('ds-page-split');
    expect(has(frame(), 'grid')).toBe(true);
  });
});
