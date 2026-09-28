// @vitest-environment jsdom
//
// [SID:4379] 문서 서식 단추(굵게 · 기울임 · 제목 · 목록 …)는 켜고 끄는 것 — 켜짐을 색으로만 보이던 것을 보조기기에도(aria-pressed).
// 동작 단추(실행 취소 · 다시 실행 · 링크 넣기)는 active를 안 넘겨 «눌림» 상태를 안 알린다.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BubbleButton, ToolbarButton } from './doc-editor';

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

async function render(node: React.ReactNode) {
  await act(async () => { root.render(node); });
  return container.querySelector('button')!;
}

describe('[SID:4379] 문서 서식 단추 눌림 상태', () => {
  it.each([true, false])('ToolbarButton active=%s → aria-pressed 같은 값', async (active) => {
    const btn = await render(<ToolbarButton active={active} onClick={() => {}}>굵게</ToolbarButton>);
    expect(btn.getAttribute('aria-pressed')).toBe(String(active));
  });

  it('ToolbarButton 동작 단추(active 없음)는 aria-pressed를 안 싣는다', async () => {
    const btn = await render(<ToolbarButton onClick={() => {}} ariaLabel="실행 취소">↶</ToolbarButton>);
    expect(btn.hasAttribute('aria-pressed')).toBe(false);
  });

  it.each([true, false])('BubbleButton active=%s → aria-pressed 같은 값', async (active) => {
    const btn = await render(<BubbleButton active={active} onClick={() => {}} title="굵게">B</BubbleButton>);
    expect(btn.getAttribute('aria-pressed')).toBe(String(active));
  });
});
