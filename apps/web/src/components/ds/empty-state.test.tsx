// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EmptyState } from './empty-state';

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

describe('ds EmptyState', () => {
  it('한 줄 + 다음 행동 하나', async () => {
    await act(async () => { root.render(<EmptyState title="손댈 일이 없어요" description="에이전트들이 알아서 가고 있어요" action={<button type="button">일감 보기</button>} />); });
    expect(container.textContent).toContain('손댈 일이 없어요');
    expect(container.textContent).toContain('에이전트들이 알아서 가고 있어요');
    expect(container.querySelector('button')!.textContent).toBe('일감 보기');
  });

  it('아이콘 · 설명 · 행동은 선택(없으면 안 그린다)', async () => {
    await act(async () => { root.render(<EmptyState title="비었어요" />); });
    expect(container.querySelector('svg')).toBeNull();
    expect(container.querySelectorAll('p')).toHaveLength(1);
    await act(async () => { root.render(<EmptyState title="비었어요" icon="inbox" />); });
    expect(container.querySelector('[data-icon="inbox"]')).not.toBeNull();
  });
});
