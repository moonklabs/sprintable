// @vitest-environment jsdom
// story #4888(UI-5 홈) — 분 시계는 «마운트 60초 뒤»가 아니라 «분 경계»에 갱신된다(기다린 시간이 분 단위라 최대 한 분 낡으면 틀린 숫자를 찍는다).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useMinuteClock } from './use-minute-clock';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
function Probe() { return <span data-testid="t">{new Date(useMinuteClock()).toISOString().slice(11, 19)}</span>; }
const shown = () => document.body.querySelector('[data-testid="t"]')!.textContent;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-11T12:00:40Z')); });
afterEach(async () => { await act(async () => { root.unmount(); }); document.body.innerHTML = ''; vi.useRealTimers(); });
async function mount() {
  const el = document.createElement('div'); document.body.appendChild(el); root = createRoot(el);
  await act(async () => { root.render(<Probe />); });
}

describe('useMinuteClock', () => {
  it('⭐분으로 내림한 시각을 준다(12:00:40 → 12:00:00)', async () => {
    await mount();
    expect(shown()).toBe('12:00:00');
  });
  it('⭐분 경계(12:01:00)에 맞춰 갱신된다 — 마운트 60초 뒤(12:01:40)까지 기다리지 않는다', async () => {
    await mount();
    await act(async () => { vi.advanceTimersByTime(19_000); });   // 12:00:59 — 아직
    expect(shown()).toBe('12:00:00');
    await act(async () => { vi.advanceTimersByTime(1_000); });    // 12:01:00 — 경계
    expect(shown()).toBe('12:01:00');
    await act(async () => { vi.advanceTimersByTime(60_000); });   // 12:02:00 — 다음 경계
    expect(shown()).toBe('12:02:00');
  });
  it('내려가면 타이머를 걷는다', async () => {
    await mount();
    await act(async () => { root.unmount(); });
    expect(vi.getTimerCount()).toBe(0);
    const el = document.createElement('div'); document.body.appendChild(el); root = createRoot(el);   // afterEach용
  });
});
