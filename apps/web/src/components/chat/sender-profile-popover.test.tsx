// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SenderProfilePopover } from './sender-profile-popover';

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

const NOOP = () => {};

describe('SenderProfilePopover — story #2349 "상대 프로필" 진입점', () => {
  it('이름을 그린다', async () => {
    await act(async () => {
      root.render(<SenderProfilePopover x={0} y={0} name="오르테가" isAgent onClose={NOOP} />);
    });
    expect(container.textContent).toContain('오르테가');
  });

  it('onBlock을 안 주면 「사용자 차단」 버튼이 안 그려진다', async () => {
    await act(async () => {
      root.render(<SenderProfilePopover x={0} y={0} name="오르테가" isAgent onClose={NOOP} />);
    });
    expect(container.textContent).not.toContain('사용자 차단');
  });

  it('onBlock을 주면 「사용자 차단」이 뜨고 클릭 시 onBlock+onClose가 불린다', async () => {
    const onBlock = vi.fn();
    const onClose = vi.fn();
    await act(async () => {
      root.render(<SenderProfilePopover x={0} y={0} name="민" isAgent={false} onClose={onClose} onBlock={onBlock} />);
    });
    const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('사용자 차단'));
    expect(btn).not.toBeUndefined();
    await act(async () => { btn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onBlock).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape를 누르면 onClose가 불린다', async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(<SenderProfilePopover x={0} y={0} name="민" isAgent={false} onClose={onClose} />);
    });
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('바깥을 클릭하면 onClose가 불린다', async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(<SenderProfilePopover x={0} y={0} name="민" isAgent={false} onClose={onClose} />);
    });
    await act(async () => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
