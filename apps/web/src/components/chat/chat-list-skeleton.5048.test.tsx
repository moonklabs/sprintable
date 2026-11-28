// story 5048 ⑤-⑨ — 대화 목록 «읽는 중»은 글자만이 아니라 ds SkeletonGroup(이름 = 불러오는 중) + 줄마다 원 · 막대 둘(chats/loading과 같은 모양).
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChatListSkeleton } from './chat-list-skeleton';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

describe('ChatListSkeleton', () => {
  it('⭐ds SkeletonGroup(role=status · aria-busy · 이름) · 줄 여섯 × (원 + 막대 둘) · 글자 0 · 옛 ui 막대 0', async () => {
    await act(async () => { root.render(<ChatListSkeleton label="불러오는 중…" />); });
    const g = container.querySelector('[data-slot="ds-skeleton-group"]') as HTMLElement;
    expect(g.getAttribute('role')).toBe('status');
    expect(g.getAttribute('aria-busy')).toBe('true');
    expect(g.getAttribute('aria-label')).toBe('불러오는 중…');
    expect(g.querySelectorAll('[data-variant="circle"]')).toHaveLength(6);
    expect(g.querySelectorAll('[data-slot="ds-skeleton"]')).toHaveLength(6 * 3);
    expect(g.textContent).toBe('');
    expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(0);
    await act(async () => { root.render(<ChatListSkeleton label="x" rows={2} />); });
    expect(container.querySelectorAll('[data-slot="ds-skeleton"]')).toHaveLength(2 * 3);
  });
});
