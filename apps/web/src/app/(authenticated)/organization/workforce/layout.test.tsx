// @vitest-environment jsdom
//
// story 5035 (C5) — the «팀» strip band (story 4889) is gone from the agents' place: its layout now hands every agent screen to the list → detail frame (components/agents/workforce-frame.tsx · pinned by workforce-frame.test.tsx).
// «사람» keeps the strip in members' own layout (team-tabs.test.tsx). Reverting the layout back to the strip turns this red.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('@/components/agents/workforce-frame', () => ({ WorkforceFrame: ({ children }: { children: React.ReactNode }) => <div data-testid="frame-stub">{children}</div> }));
vi.mock('@/components/team/team-tabs', () => ({ TeamTabs: () => <nav data-testid="team-tabs-stub" /> }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

describe('workforce layout — 목록 → 상세 틀(story 5035)', () => {
  it('⭐본문은 틀 안에 들어가고, 옛 «팀» 줄(띠)은 이 레이아웃에 없다', async () => {
    const { default: WorkforceLayout } = await import('./layout');
    await act(async () => { root.render(<WorkforceLayout><div data-testid="body" /></WorkforceLayout>); });
    expect(container.querySelector('[data-testid="frame-stub"] [data-testid="body"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="team-tabs-band"]')).toBeNull();
    expect(container.querySelector('[data-testid="team-tabs-stub"]')).toBeNull();
  });
});
