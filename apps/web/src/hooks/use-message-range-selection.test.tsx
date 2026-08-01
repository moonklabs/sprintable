// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useMessageRangeSelection, type MessageRangeSelection } from './use-message-range-selection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ORDERED_IDS = ['m1', 'm2', 'm3', 'm4', 'm5'];

let container: HTMLDivElement;
let root: Root;
let current: MessageRangeSelection;

function Harness() {
  const selection = useMessageRangeSelection();
  useEffect(() => { current = selection; });
  return null;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

function mount() {
  act(() => { root.render(<Harness />); });
}

describe('useMessageRangeSelection — story #2265(C-7) PR2 선택 상태 기계', () => {
  it('idle에서 시작 — startSelection 전에는 anchor도 range도 없다', () => {
    mount();
    expect(current.mode).toBe('idle');
    expect(current.isAnchor('m1')).toBe(false);
    expect(current.isInRange('m1', ORDERED_IDS)).toBe(false);
  });

  it('startSelection 후 anchored — 그 메시지만 anchor로 표시된다', () => {
    mount();
    act(() => current.startSelection('m2'));
    expect(current.mode).toBe('anchored');
    expect(current.isAnchor('m2')).toBe(true);
    expect(current.isAnchor('m3')).toBe(false);
  });

  it('정순(anchor가 먼저) — confirmEnd 후 range가 anchor→end 그대로 선다', () => {
    mount();
    act(() => current.startSelection('m2'));
    act(() => current.confirmEnd('m4', ORDERED_IDS));
    expect(current.mode).toBe('confirming');
    expect(current.rangeStartId).toBe('m2');
    expect(current.rangeEndId).toBe('m4');
  });

  it('역순(사용자가 나중 메시지를 먼저 짚음) — start/end가 시간순으로 자동 정규화된다', () => {
    mount();
    act(() => current.startSelection('m4'));
    act(() => current.confirmEnd('m2', ORDERED_IDS));
    expect(current.rangeStartId).toBe('m2');
    expect(current.rangeEndId).toBe('m4');
  });

  it('같은 메시지를 두 번 짚으면 — 1건짜리 range로 선다(0건이 아니다)', () => {
    mount();
    act(() => current.startSelection('m3'));
    act(() => current.confirmEnd('m3', ORDERED_IDS));
    expect(current.rangeStartId).toBe('m3');
    expect(current.rangeEndId).toBe('m3');
    expect(current.isInRange('m3', ORDERED_IDS)).toBe(true);
    expect(current.isInRange('m2', ORDERED_IDS)).toBe(false);
  });

  it('isInRange — 확定된 range 안(양끝 포함)만 true, 밖은 false', () => {
    mount();
    act(() => current.startSelection('m2'));
    act(() => current.confirmEnd('m4', ORDERED_IDS));
    expect(current.isInRange('m1', ORDERED_IDS)).toBe(false);
    expect(current.isInRange('m2', ORDERED_IDS)).toBe(true);
    expect(current.isInRange('m3', ORDERED_IDS)).toBe(true);
    expect(current.isInRange('m4', ORDERED_IDS)).toBe(true);
    expect(current.isInRange('m5', ORDERED_IDS)).toBe(false);
  });

  it('anchor나 end가 orderedMessageIds에 없으면(가상화로 밀려남 등) confirmEnd가 조용히 무시된다 — 순서를 지어내지 않는다', () => {
    mount();
    act(() => current.startSelection('m2'));
    act(() => current.confirmEnd('unknown-id', ORDERED_IDS));
    expect(current.mode).toBe('anchored'); // confirming으로 안 넘어간다.
    expect(current.rangeStartId).toBeNull();
  });

  it('anchored가 아닌 상태(idle)에서 confirmEnd를 불러도 아무 일도 안 일어난다', () => {
    mount();
    act(() => current.confirmEnd('m2', ORDERED_IDS));
    expect(current.mode).toBe('idle');
  });

  it('cancel — 언제든 idle로 완전히 되돌아간다', () => {
    mount();
    act(() => current.startSelection('m2'));
    act(() => current.confirmEnd('m4', ORDERED_IDS));
    act(() => current.cancel());
    expect(current.mode).toBe('idle');
    expect(current.anchorId).toBeNull();
    expect(current.rangeStartId).toBeNull();
    expect(current.rangeEndId).toBeNull();
    expect(current.isInRange('m3', ORDERED_IDS)).toBe(false);
  });

  it('confirming 상태에서 다시 startSelection을 부르면 — 이전 range를 버리고 새 anchor로 재시작한다', () => {
    mount();
    act(() => current.startSelection('m1'));
    act(() => current.confirmEnd('m3', ORDERED_IDS));
    act(() => current.startSelection('m5'));
    expect(current.mode).toBe('anchored');
    expect(current.anchorId).toBe('m5');
    expect(current.rangeStartId).toBeNull();
    expect(current.isInRange('m2', ORDERED_IDS)).toBe(false); // 옛 range 잔재 없음.
  });
});
