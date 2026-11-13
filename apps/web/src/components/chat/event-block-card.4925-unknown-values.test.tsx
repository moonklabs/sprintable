// @vitest-environment jsdom
//
// story 4925 — the CARD's labels (the same builder that feeds `{{label.X}}`): a status / work item type / verdict no label knows reads as words, not as its slug. The real card + a template that reads the four labels.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { EventBlockCard } from './event-block-card';
import koMessages from '../../../messages/ko.json';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement; let root: Root;
const TEMPLATE = { blocks: [{ type: 'text' as const, text: '{{label.work_item_type}} | {{label.from_status}} → {{label.to_status}} | {{label.verdict}}' }] };
beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  useDashboardContextMock.mockReturnValue({ currentMemberType: 'human', role: 'admin', orgId: 'org-1' });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [], error: null, meta: null }) })));
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

async function draw(payload: Record<string, unknown>) {
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><EventBlockCard template={TEMPLATE} payload={payload} /></NextIntlClientProvider>);
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('EventBlockCard — values no label knows (story 4925)', () => {
  it('⭐an unknown status · work item type · verdict read as words; known ones are their labels', async () => {
    await draw({ work_item_type: 'visual_artifact', from_status: 'waiting-on-legal', to_status: 'ready_to_ship', verdict: 'on-hold_by_legal' });
    expect(container.textContent).toBe('visual artifact | waiting on legal → ready to ship | on hold by legal');
  });
  it('known values keep their labels', async () => {
    await draw({ work_item_type: 'story', from_status: 'in-progress', to_status: 'in-review', verdict: 'approved' });
    expect(container.textContent).toContain('스토리');
    expect(container.textContent).toContain('승인');
    expect(container.textContent).not.toMatch(/in-progress|in-review|approved/);
  });
});
