// @vitest-environment jsdom
//
// story 4889 — «팀» 탭줄이 셸 칼럼 왼쪽 끝에 붙어 있었다(판정 캡처: 줄 x≈316 · 본문 판 x≈312). 일감 줄 띠(WorkTabsFrame · px-4 pt-3)와 같은 안쪽 여백의 띠 안에 선다. 되돌리면 빨갛다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('@/components/team/team-tabs', () => ({ TeamTabs: () => <nav data-testid="team-tabs-stub" /> }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

describe('workforce layout — «팀» 줄 띠(story 4889)', () => {
  it('⭐줄은 일감 줄 띠와 같은 안쪽 여백(px-4 pt-3)의 띠 안에 서고, 본문은 띠 밖(그 아래)에 온다', async () => {
    const { default: WorkforceLayout } = await import('./layout');
    await act(async () => { root.render(<WorkforceLayout><div data-testid="body" /></WorkforceLayout>); });
    const band = container.querySelector('[data-testid="team-tabs-band"]')!;
    expect(band).toBeTruthy();
    expect(band.className).toContain('px-4');
    expect(band.className).toContain('pt-3');
    expect(band.querySelector('[data-testid="team-tabs-stub"]')).toBeTruthy();
    const body = container.querySelector('[data-testid="body"]')!;
    expect(band.contains(body)).toBe(false);
    expect(band.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
