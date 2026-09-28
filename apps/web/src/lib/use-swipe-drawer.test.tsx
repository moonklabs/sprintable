// @vitest-environment jsdom
//
// [SID:4288 · 까디르 4653 P1] 스와이프를 놓으면 progress가 0 · 1로 반드시 정착하는가(닫힌 서랍을 조금 끌다 놓았을 때 0.1 따위로 남으면
// 닫힘 판정에서 빠져 inert가 풀린 채 화면 밖 서랍이 초점을 받는다) · touchcancel이면 시작 상태로 돌아가는가. 실제 훅 + document
// 터치 이벤트(jsdom엔 TouchEvent 생성자가 없어 Event에 touches · changedTouches를 싣는다).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { closedDrawerProps, useSwipeDrawer } from './use-swipe-drawer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const seen: { progress: number; dragging: boolean; isOpen: boolean }[] = [];

function Harness({ initialOpen = false }: { initialOpen?: boolean }) {
  const [isOpen, setOpen] = useState(initialOpen);
  const { progress, dragging } = useSwipeDrawer(isOpen, () => setOpen(true), () => setOpen(false));
  seen.push({ progress, dragging, isOpen });
  return <div data-testid="d" {...closedDrawerProps(progress, isOpen)} />;
}

function touch(type: string, x: number, { noChanged = false } = {}) {
  const e = new Event(type, { bubbles: true });
  const list = [{ clientX: x, clientY: 100 }];
  Object.defineProperty(e, 'touches', { value: type === 'touchend' || type === 'touchcancel' ? [] : list });
  Object.defineProperty(e, 'changedTouches', { value: noChanged ? [] : list });
  document.dispatchEvent(e);
}

const last = () => seen[seen.length - 1]!;
const drawer = () => container.querySelector('[data-testid="d"]')!;

beforeEach(() => {
  seen.length = 0;
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function mount(initialOpen = false) {
  await act(async () => { root.render(<Harness initialOpen={initialOpen} />); });
}

describe('useSwipeDrawer — 놓으면 0 · 1로 정착 · touchcancel은 시작 상태로([SID:4288])', () => {
  it('닫힌 서랍을 가장자리에서 조금(문턱 미만) 끌다 놓으면 progress 0 · 닫힘(inert) — 중간값으로 남지 않는다', async () => {
    await mount(false);
    await act(async () => { touch('touchstart', 10); touch('touchmove', 40); });
    expect(last().progress).toBeGreaterThan(0);
    expect(last().progress).toBeLessThan(0.3);
    await act(async () => { touch('touchend', 40); });
    expect(last().progress).toBe(0);
    expect(last().isOpen).toBe(false);
    expect(drawer().hasAttribute('inert')).toBe(true);
  });

  it('문턱을 넘겨 놓으면 열림 · progress 1', async () => {
    await mount(false);
    await act(async () => { touch('touchstart', 10); touch('touchmove', 200); touch('touchend', 200); });
    expect(last().isOpen).toBe(true);
    expect(last().progress).toBe(1);
    expect(drawer().hasAttribute('inert')).toBe(false);
  });

  it('열린 서랍을 조금(문턱 미만) 밀다 놓으면 다시 1로 — 열린 채', async () => {
    await mount(true);
    await act(async () => { touch('touchstart', 200); touch('touchmove', 170); touch('touchend', 170); });
    expect(last().isOpen).toBe(true);
    expect(last().progress).toBe(1);
  });

  it('touchcancel — 끄는 중이던 진행을 시작 상태(닫힘 0)로 되돌리고 dragging을 푼다', async () => {
    await mount(false);
    await act(async () => { touch('touchstart', 10); touch('touchmove', 60); });
    expect(last().dragging).toBe(true);
    await act(async () => { touch('touchcancel', 60); });
    expect(last().dragging).toBe(false);
    expect(last().progress).toBe(0);
    expect(drawer().hasAttribute('inert')).toBe(true);
  });

  it('놓을 때 위치 정보가 없으면(changedTouches 빔) 시작 상태로', async () => {
    await mount(false);
    await act(async () => { touch('touchstart', 10); touch('touchmove', 60); touch('touchend', 60, { noChanged: true }); });
    expect(last().progress).toBe(0);
    expect(last().dragging).toBe(false);
  });
});
