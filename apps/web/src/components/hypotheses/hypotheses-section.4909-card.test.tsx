// @vitest-environment jsdom
//
// 4909 AC3 (가설 칸 1단계) — the hypotheses card on the ds parts: its FACE is the content layer (LAYER.panel — one step above the page; the old `bg-muted/20` card measured −.018 light / −.004 dark against the page and did not separate),
// the head carries the title (+ the count once there are hypotheses) and two ds Buttons that still WRAP, the AI-draft preview is the ds info face with ds Buttons, the failure line is the ds failed face. Data · requests · transitions are untouched
// (their own tests run unchanged). Every test goes RED if the thing it names is put back the old way.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import type { Hypothesis } from '@sprintable/core-storage';
import koMessages from '../../../messages/ko.json';
import { LAYER } from '@/components/ds/layers';

vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ({ currentTeamMemberId: 'me-1' }) }));
const fetchWithAuthMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db/client', async (orig) => ({ ...(await orig<Record<string, unknown>>()), fetchWithAuth: fetchWithAuthMock }));

import { HypothesesSection } from './hypotheses-section';
import { HYPOTHESES_FACE } from './hypotheses-face';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const tokens = (el: Element) => el.className.split(/\s+/);

const hyp = (id: string): Hypothesis => ({
  id, org_id: 'org-1', project_id: 'proj-1', owner_member_id: 'm1', created_by_member_id: null, confirmed_by_member_id: null,
  statement: `가설 ${id}`, metric_definition: { metric: 'activation', target: 10, direction: 'up' } as never, measure_after: '2026-12-01T00:00:00Z',
  status: 'active', outcome_result: null, confidence: null, source_type: null, source_id: null, human_accounting: {}, gate_contract: {},
  epic_ids: [], story_ids: [], created_at: '2026-09-25T00:00:00Z', updated_at: '2026-09-25T00:00:00Z',
} as Hypothesis);

const PREVIEW = {
  statement: '미리 보인 문장', metric_definition: { metric: 'session_minutes', source: 'manual', target: 3, direction: 'up' },
  measure_after: '2026-11-26T03:04:05.000Z', source_snapshot: {}, confidence: null, requires_confirmation: true, hypothesis: null,
};

beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); fetchWithAuthMock.mockReset(); vi.unstubAllGlobals(); });
const flush = async () => { for (let i = 0; i < 8; i += 1) await act(async () => { await Promise.resolve(); }); };

async function mount(items: Hypothesis[] = []) {
  fetchWithAuthMock.mockImplementation(async (url: string) => ({ ok: true, json: async () => (String(url).startsWith('/api/hypotheses?') ? { data: items } : []) }));
  vi.stubGlobal('fetch', vi.fn(async (input: string) => (String(input) === '/api/hypotheses/draft' ? { ok: true, json: async () => ({ data: PREVIEW }) } : { ok: true, json: async () => ({ data: [] }) })));
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><HypothesesSection epicId="e1" projectId="proj-1" /></NextIntlClientProvider>); });
  await flush();
}
const section = () => container.querySelector('[data-testid="hypotheses-section"]') as HTMLElement;
const btn = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined;

describe('HypothesesSection — 4909 가설 칸 1단계 (ds 부품 · 층)', () => {
  it('⭐the card face IS the content layer (LAYER.panel) — not the old translucent muted wash, and not the page layer', async () => {
    await mount();
    expect(HYPOTHESES_FACE).toBe(LAYER.panel);
    expect(tokens(section())).toContain(LAYER.panel);
    expect(tokens(section())).not.toContain(LAYER.page);
    expect(section().className).not.toMatch(/bg-muted|bg-background|rounded-xl/);
    expect(tokens(section())).toContain('border-ds-line');
  });

  it('⭐the head: the title is the card title (a heading) · two ds Buttons beside it that keep the wrapping classes the 4906 lap found', async () => {
    await mount();
    expect(container.querySelector('[data-testid="hypotheses-head"] h2')?.textContent).toContain('가설');
    const actions = container.querySelector('[data-testid="hypotheses-head-actions"]') as HTMLElement;
    expect(tokens(container.querySelector('[data-testid="hypotheses-head"]')!)).toContain('flex-wrap');
    expect(tokens(actions)).toContain('flex-wrap');
    expect(tokens(actions)).not.toContain('shrink-0');
    const buttons = [...actions.querySelectorAll('button')];
    expect(buttons).toHaveLength(2);
    expect(buttons.every((b) => b.getAttribute('data-slot') === 'ds-button')).toBe(true);
    expect(buttons.map((b) => b.textContent?.trim())).toEqual([koMessages.hypotheses.draftCta, koMessages.hypotheses.add]);
  });

  it('the count sits beside the title only once there are hypotheses (none → no number; two → «2»)', async () => {
    await mount([]);
    expect(container.querySelector('[data-testid="hypotheses-count"]')).toBeNull();
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await mount([hyp('h1'), hyp('h2')]);
    expect(container.querySelector('[data-testid="hypotheses-count"]')?.textContent).toBe('2');
  });

  it('the empty line is the quiet ds ink', async () => {
    await mount([]);
    const empty = [...container.querySelectorAll('p')].find((p) => p.textContent === koMessages.hypotheses.empty);
    expect(tokens(empty!)).toContain('text-ds-ink-3');
  });

  it('⭐the AI-draft preview is the ds info face with two ds Buttons (cancel quiet · accept primary) — and the head buttons hide while it is open (same rule as before)', async () => {
    await mount();
    await act(async () => { btn(koMessages.hypotheses.draftCta)!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    const cancel = btn(koMessages.hypotheses.cancel)!; const accept = btn(koMessages.hypotheses.draftAccept)!;
    expect(cancel && accept).toBeTruthy();
    expect(cancel.getAttribute('data-slot')).toBe('ds-button');
    expect(tokens(accept)).toContain('bg-ds-action'); // primary
    expect(tokens(cancel)).toEqual(expect.arrayContaining(['border-transparent', 'text-ds-ink-2'])); // quiet (secondary has a visible control border; danger the failed colour)
    expect(tokens(cancel)).not.toContain('bg-ds-action');
    expect(tokens(cancel)).not.toContain('border-ds-line-control');
    expect(tokens(cancel)).not.toContain('border-ds-failed');
    expect(section().innerHTML).toContain('bg-ds-info-soft');
    expect(section().innerHTML).not.toMatch(/bg-primary\/5|border-primary\/30/);
    expect(container.querySelector('[data-testid="hypotheses-head-actions"]')).toBeNull();
    expect(container.textContent).toContain('미리 보인 문장');
  });
});
