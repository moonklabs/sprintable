// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MessageContextMenu } from './message-context-menu';

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

describe('MessageContextMenu — story #2265(C-7) PR2 citeAction 확장', () => {
  it('citeAction을 안 주면(기존 호출부) 인용 항목이 안 그려진다(회귀 0)', async () => {
    await act(async () => {
      root.render(
        <MessageContextMenu x={0} y={0} isMine={false} onReply={NOOP} onCopy={NOOP} onDelete={NOOP} onClose={NOOP} />,
      );
    });
    expect(container.textContent).not.toContain('인용');
  });

  it('citeAction kind="start"이면 "여기부터 인용"이 뜨고 클릭 시 onSelect+onClose가 불린다', async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    await act(async () => {
      root.render(
        <MessageContextMenu
          x={0} y={0} isMine={false} onReply={NOOP} onCopy={NOOP} onDelete={NOOP} onClose={onClose}
          citeAction={{ kind: 'start', onSelect }}
        />,
      );
    });
    expect(container.textContent).toContain('여기부터 인용');
    const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('여기부터 인용'));
    expect(btn).not.toBeUndefined();
    await act(async () => { btn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('citeAction kind="end"이면 "여기까지 인용"이 뜬다(이미 anchor가 찍힌 상태를 반영)', async () => {
    await act(async () => {
      root.render(
        <MessageContextMenu
          x={0} y={0} isMine={false} onReply={NOOP} onCopy={NOOP} onDelete={NOOP} onClose={NOOP}
          citeAction={{ kind: 'end', onSelect: NOOP }}
        />,
      );
    });
    expect(container.textContent).toContain('여기까지 인용');
    expect(container.textContent).not.toContain('여기부터 인용');
  });

  it('기존 메뉴 항목(답글·복사)은 citeAction 유무와 무관하게 그대로 있다', async () => {
    await act(async () => {
      root.render(
        <MessageContextMenu
          x={0} y={0} isMine={false} onReply={NOOP} onCopy={NOOP} onDelete={NOOP} onClose={NOOP}
          citeAction={{ kind: 'start', onSelect: NOOP }}
        />,
      );
    });
    expect(container.textContent).toContain('답글 달기');
    expect(container.textContent).toContain('복사');
  });
});
