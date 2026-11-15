// @vitest-environment jsdom
// UI-3(a9d56577) — ds ProgressBar 회귀가드: role=progressbar + 값 속성 · 이름 필수 · 채움 너비(범위 맞춤) · 진척이 다 차면 done / 사용량은 action 그대로 · 모름(null) ≠ 0 · 오른쪽 숫자 글.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ProgressBar } from './progress-bar';

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
const bar = () => container.querySelector('[role="progressbar"]') as HTMLElement;
const fill = () => container.querySelector('[data-slot="ds-progress-fill"]') as HTMLElement;
const text = () => container.querySelector('[data-slot="ds-progress-text"]');
const has = (el: Element, c: string) => el.className.split(/\s+/).includes(c);

describe('ds ProgressBar', () => {
  it('⭐role=progressbar + aria-valuenow/min/max + 이름(aria-label) — 오른쪽에 «n/m»', async () => {
    await render(<ProgressBar aria-label="작업 진척" value={8} max={10} />);
    expect(bar().getAttribute('aria-label')).toBe('작업 진척');
    expect(bar().getAttribute('aria-valuenow')).toBe('8');
    expect(bar().getAttribute('aria-valuemin')).toBe('0');
    expect(bar().getAttribute('aria-valuemax')).toBe('10');
    expect(text()!.textContent).toBe('8/10');
    expect(fill().style.width).toBe('80%');
  });

  it('이름은 aria-labelledby로도 준다 · 읽는 값 글(ariaValueText)', async () => {
    await render(<><span id="t">사용량</span><ProgressBar aria-labelledby="t" value={3} max={4} ariaValueText="4개 중 3개" /></>);
    expect(bar().getAttribute('aria-labelledby')).toBe('t');
    expect(bar().getAttribute('aria-valuetext')).toBe('4개 중 3개');
  });

  it('⭐채움 너비는 0~100%로 맞춘다 — 음수 · 넘침 · NaN · max 0', async () => {
    const w = async (v: number, m: number) => { await render(<ProgressBar aria-label="x" value={v} max={m} />); return fill().style.width; };
    expect(await w(-3, 10)).toBe('0%');
    expect(await w(25, 10)).toBe('100%');
    expect(await w(Number.NaN, 10)).toBe('0%');
    expect(await w(5, 0)).toBe('0%');
    expect(await w(0, 10)).toBe('0%');
    // 값 속성도 범위 안: 넘친 값은 max로
    await render(<ProgressBar aria-label="x" value={25} max={10} />);
    expect(bar().getAttribute('aria-valuenow')).toBe('10');
    // max가 0 이하면 비율을 못 세우니 now · max 속성을 내지 않는다
    await render(<ProgressBar aria-label="x" value={5} max={0} />);
    expect(bar().hasAttribute('aria-valuenow')).toBe(false);
    expect(bar().hasAttribute('aria-valuemax')).toBe(false);
  });

  it('⭐진척(progress)은 다 차면 done · 덜 차면 action', async () => {
    await render(<ProgressBar aria-label="x" value={10} max={10} />);
    expect(has(fill(), 'bg-ds-done')).toBe(true);
    expect(bar().getAttribute('data-complete')).toBe('true');
    await render(<ProgressBar aria-label="x" value={9} max={10} />);
    expect(has(fill(), 'bg-ds-action')).toBe(true);
    expect(has(fill(), 'bg-ds-done')).toBe(false);
  });

  it('⭐사용량(usage)은 다 차도 action 그대로 — 한도에 닿은 것은 «끝남»이 아니다', async () => {
    await render(<ProgressBar aria-label="x" tone="usage" value={10} max={10} />);
    expect(has(fill(), 'bg-ds-action')).toBe(true);
    expect(has(fill(), 'bg-ds-done')).toBe(false);
  });

  it('⭐모름(null)은 0이 아니다: 막대 비고 «—» + 읽히는 이유(aria-valuetext) · now/max 속성 없음', async () => {
    await render(<ProgressBar aria-label="사용량" value={null} max={40} unavailableLabel="아직 집계하지 못했어요" />);
    expect(fill().style.width).toBe('0%');
    expect(text()!.textContent).toBe('—');
    expect(bar().getAttribute('aria-valuetext')).toBe('아직 집계하지 못했어요');
    expect(bar().hasAttribute('aria-valuenow')).toBe(false);
    expect(container.querySelector('[data-slot="ds-progress"]')!.getAttribute('data-unavailable')).toBe('true');
    // 0은 0이다
    await render(<ProgressBar aria-label="사용량" value={0} max={40} />);
    expect(text()!.textContent).toBe('0/40');
    expect(bar().getAttribute('aria-valuenow')).toBe('0');
  });

  it('⭐NaN · Infinity도 모름이다 — aria-valuenow="NaN"을 내보내지 않고 막대 비율과 값 속성이 갈리지 않는다', async () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      await render(<ProgressBar aria-label="x" value={bad} max={10} />);
      expect(bar().hasAttribute('aria-valuenow'), String(bad)).toBe(false);
      expect(fill().style.width, String(bad)).toBe('0%');
      expect(text()!.textContent, String(bad)).toBe('—');
    }
  });

  it('⭐끝 값(max)이 숫자가 아니면 «5/NaN»을 그리지 않는다 — 모름("—")이고 값 속성도 안 낸다', async () => {
    for (const badMax of [Number.NaN, Number.POSITIVE_INFINITY]) {
      await render(<ProgressBar aria-label="x" value={5} max={badMax} />);
      expect(text()!.textContent, String(badMax)).toBe('—');
      expect(container.textContent, String(badMax)).not.toMatch(/NaN|Infinity/);
      expect(bar().hasAttribute('aria-valuenow'), String(badMax)).toBe(false);
      expect(bar().hasAttribute('aria-valuemax'), String(badMax)).toBe(false);
    }
  });

  it('⭐숫자가 NaN이어도 읽힐 글(unavailableLabel)을 줄 수 있다 — 값 글에 «NaN»이 읽히지 않는다', async () => {
    await render(<ProgressBar aria-label="x" value={Number.NaN} max={10} unavailableLabel="아직 집계하지 못했어요" />);
    expect(bar().getAttribute('aria-valuetext')).toBe('아직 집계하지 못했어요');
    expect(bar().hasAttribute('aria-valuenow')).toBe(false);
    expect(container.textContent).not.toMatch(/NaN/);
  });

  it('오른쪽 숫자 글: 직접 주면 그 글 · false면 그리지 않는다', async () => {
    await render(<ProgressBar aria-label="x" value={1} max={2} valueText="절반" />);
    expect(text()!.textContent).toBe('절반');
    await render(<ProgressBar aria-label="x" value={1} max={2} valueText={false} />);
    expect(text()).toBeNull();
  });

  it('높이 4 · 칸 surface-highest · 둥근 끝 · 너비만 100ms 움직이고 움직임 줄이기면 즉시', async () => {
    await render(<ProgressBar aria-label="x" value={1} max={2} />);
    expect(has(bar(), 'h-1')).toBe(true);
    expect(has(bar(), 'bg-ds-surface-highest')).toBe(true);
    expect(has(fill(), 'transition-[width]')).toBe(true);
    expect(has(fill(), 'duration-(--ds-duration-fast)')).toBe(true);
    expect(has(fill(), 'motion-reduce:transition-none')).toBe(true);
  });

  it('호출부 속성이 막대에 닿고 role은 덮이지 않는다 · className은 바깥 줄에', async () => {
    await render(<ProgressBar aria-label="x" value={1} max={2} className="mt-2" data-testid="p" {...({ role: 'presentation' } as object)} />);
    expect(bar().getAttribute('data-testid')).toBe('p');
    expect(bar().getAttribute('role')).toBe('progressbar');
    expect(has(container.querySelector('[data-slot="ds-progress"]') as Element, 'mt-2')).toBe(true);
  });
});
