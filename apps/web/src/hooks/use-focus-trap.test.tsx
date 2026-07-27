// @vitest-environment jsdom
//
// story #2061 — 손수 구현 모달 중 공용 Dialog(base-ui)로 바로 못 바꾸는 자리(예: 반응형
// 드로어·제스처 드로어)를 위한 최소 포커스 트랩 훅. 실제 DOM(createRoot)으로 Tab 순환·
// Escape·포커스 반환을 검증한다 — 정적 속성 존재 주장이 아니라 키 입력을 실제로 디스패치한다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useFocusTrap } from './use-focus-trap';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function TestModal({ active, onClose, handleEscape }: { active: boolean; onClose: () => void; handleEscape?: boolean }) {
  const ref = useFocusTrap(active, onClose, { handleEscape });
  if (!active) return null;
  return (
    <div ref={ref} tabIndex={-1} data-testid="modal">
      <button type="button">first</button>
      <button type="button">middle</button>
      <button type="button">last</button>
    </div>
  );
}

function dispatchKey(target: EventTarget, key: string, shiftKey = false) {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('useFocusTrap — story #2061', () => {
  it('활성화되면 컨테이너 안의 첫 포커스 가능한 요소로 초점이 이동한다', async () => {
    const outside = document.createElement('button');
    outside.textContent = 'outside';
    document.body.appendChild(outside);
    outside.focus();

    await act(async () => {
      root.render(<TestModal active onClose={() => {}} />);
    });

    const first = container.querySelector('button');
    expect(document.activeElement).toBe(first);
    outside.remove();
  });

  it('마지막 요소에서 Tab을 누르면 첫 요소로 순환한다', async () => {
    await act(async () => {
      root.render(<TestModal active onClose={() => {}} />);
    });
    const buttons = [...container.querySelectorAll('button')];
    const last = buttons[buttons.length - 1]!;
    last.focus();
    await act(async () => { dispatchKey(document, 'Tab'); });
    expect(document.activeElement).toBe(buttons[0]);
  });

  it('첫 요소에서 Shift+Tab을 누르면 마지막 요소로 순환한다', async () => {
    await act(async () => {
      root.render(<TestModal active onClose={() => {}} />);
    });
    const buttons = [...container.querySelectorAll('button')];
    buttons[0]!.focus();
    await act(async () => { dispatchKey(document, 'Tab', true); });
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);
  });

  it('Escape를 누르면 onClose가 호출된다(기본값)', async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(<TestModal active onClose={onClose} />);
    });
    await act(async () => { dispatchKey(document, 'Escape'); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('handleEscape:false면 Escape를 눌러도 onClose가 호출되지 않는다(호출부 자체 Esc 로직과 충돌 방지)', async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(<TestModal active onClose={onClose} handleEscape={false} />);
    });
    await act(async () => { dispatchKey(document, 'Escape'); });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('닫히면(active→false) 열기 전 포커스 자리로 돌아간다(AC3 — 트랩만 있고 반환이 없으면 화면 처음으로 튕긴다)', async () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'trigger';
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    function Wrapper({ active }: { active: boolean }) {
      return <TestModal active={active} onClose={() => {}} />;
    }

    await act(async () => { root.render(<Wrapper active />); });
    expect(document.activeElement).not.toBe(trigger);

    await act(async () => { root.render(<Wrapper active={false} />); });
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});
