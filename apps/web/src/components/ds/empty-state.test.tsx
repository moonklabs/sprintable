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

  it('⭐4913 inline — 목록 사이에 끼는 짧은 빈 칸: 아이콘을 안 그리고 위아래 16(py-4)', async () => {
    await act(async () => { root.render(<EmptyState size="inline" icon="inbox" title="구성원이 없어요" />); });
    const el = container.querySelector('[data-slot="ds-empty-state"]')!;
    expect(el.getAttribute('data-size')).toBe('inline');
    expect(el.className).toContain('py-4');
    expect(el.className).not.toContain('py-10');
    expect(container.querySelector('svg')).toBeNull();
    await act(async () => { root.render(<EmptyState title="기본" />); });
    expect(container.querySelector('[data-slot="ds-empty-state"]')!.className).toContain('py-10');
  });
});
