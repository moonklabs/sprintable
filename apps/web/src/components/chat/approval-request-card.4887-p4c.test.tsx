// @vitest-environment jsdom
//
// story 4887 (UI-4 P4-c) — the chat approval card is the ds ApprovalCard: a presentational part fed by the card's unchanged gate logic. These pin what changed in the shape:
// the part's own slots (label · title heading · state), the loading / not-found / error states as the part's states, and the one new thing — a gate that PASSED BY ITSELF (`auto_passed`)
// is no longer printed as the raw word with the rejection's X icon: it has its own words and its own neutral icon, so it never reads as a person's approval.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import { ApprovalRequestCard } from './approval-request-card';
import type { GateItem } from '@/components/kanban/types';

const useDashboardContextMock = vi.fn();
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/components/realtime-provider', () => ({ useSseMultiplexerContext: () => ({ subscribe: () => () => {} }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const gate = (o: Partial<GateItem> = {}): GateItem => ({
  id: 'g-1', org_id: 'org-1', work_item_id: 'w-1', work_item_type: 'story', gate_type: 'merge_gate', status: 'pending', resolver_id: null, resolved_at: null,
  resolution_note: null, neutral_facts: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), can_approve: true, risk_grade: 'low',
  work_item_summary: { title: '스토리 제목', slug: null }, ...o,
});
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'member-1' }); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

async function mount(fetchImpl: (url: string) => Promise<{ ok: boolean; status?: number; json: () => Promise<unknown> }>, locale: 'ko' | 'en' = 'ko') {
  vi.stubGlobal('fetch', vi.fn(fetchImpl));
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul">
        <ApprovalRequestCard target={{ work_item_type: 'story', work_item_id: 'w-1', gate_id: 'g-1', actions: ['approve', 'reject'] }} />
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
const withGate = (g: GateItem) => mount(async () => ({ ok: true, json: async () => g }));
const card = () => container.querySelector('[data-slot="ds-approval-card"]') as HTMLElement | null;

describe('ApprovalRequestCard — the ds ApprovalCard shell (story 4887 · P4-c)', () => {
  it('⭐ it is the ds ApprovalCard: the «결재 요청» label, the title as a heading (a button inside it when the work item can be previewed)', async () => {
    await withGate(gate());
    expect(card(), 'the ds part').not.toBeNull(); // reverted (the ProofCapsule shell) → null
    expect(card()!.textContent).toContain('결재 요청');
    const h = card()!.querySelector('h3');
    expect(h?.textContent).toContain('스토리 제목');
    expect(h?.querySelector('button'), 'the title opens the body preview').not.toBeNull();
  });

  it('⭐ a card that needs MY hand is the only one with the amber bar and the off-screen name; approve is the one primary action', async () => {
    await withGate(gate());
    expect(card()!.getAttribute('data-tone')).toBe('needs-hand');
    expect(card()!.textContent).toContain('내 결재가 필요해요');
    const approve = Array.from(card()!.querySelectorAll('button')).find((b) => b.textContent === '승인')!;
    const reject = Array.from(card()!.querySelectorAll('button')).find((b) => b.textContent === '반려')!;
    expect(approve.className).toContain('bg-ds-action'); // primary
    expect(reject.className).not.toContain('bg-ds-action'); // secondary — one emphasis per row
  });

  it('a card that is only waiting for someone else carries no amber bar', async () => {
    await withGate(gate({ designated_approver_id: 'someone-else', neutral_facts: { requested_by_member_id: 'member-1' } }));
    expect(card()!.getAttribute('data-tone')).toBe('default');
  });

  it('⭐ loading is the part\'s own state (role=status) and the label stays', async () => {
    let release: () => void = () => {};
    const gateRequest = new Promise<void>((r) => { release = r; });
    await mount(async () => { await gateRequest; return { ok: true, json: async () => gate() }; });
    expect(container.querySelector('[role="status"][aria-label]')).not.toBeNull();
    expect(card()!.textContent).toContain('결재 요청');
    await act(async () => { release(); await Promise.resolve(); await Promise.resolve(); });
  });

  it('⭐ not-found (404) and a load error are the part\'s states, each with its own words', async () => {
    await mount(async () => ({ ok: false, status: 404, json: async () => ({}) }));
    expect(card()!.textContent).toContain(koMessages.chats.approvalRequestNotFound);
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await mount(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    expect(card()!.textContent).toContain(koMessages.chats.approvalRequestLoadError);
  });
});

describe('ApprovalRequestCard — a gate that passed by itself (story 4887 · P4-c · auto_passed)', () => {
  it('⭐ it reads «자동 통과됨» with its own icon — not the raw word «auto_passed», not the rejection\'s X', async () => {
    await withGate(gate({ status: 'auto_passed', resolver_id: null }));
    const line = card()!.querySelector('[data-resolution]') as HTMLElement;
    expect(line.getAttribute('data-resolution')).toBe('auto_passed'); // reverted (every non-approved status drew the X) → 'rejected'/'voided'
    expect(card()!.textContent).toContain('자동 통과됨');
    expect(card()!.textContent).not.toContain('auto_passed');
    expect(line.className).not.toContain('text-ds-failed'); // neutral, never read as a rejection
    expect(line.className).not.toContain('text-ds-done'); // and never as a person's approval
  });

  it('english: «Auto-passed»', async () => {
    await mount(async () => ({ ok: true, json: async () => gate({ status: 'auto_passed' }) }), 'en');
    expect(card()!.textContent).toContain('Auto-passed');
  });

  it('an approved gate is still «approved» (done tone), a rejected one «rejected» (failed tone)', async () => {
    await withGate(gate({ status: 'approved', resolver_id: 'member-1' }));
    expect((card()!.querySelector('[data-resolution]') as HTMLElement).getAttribute('data-resolution')).toBe('approved');
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await withGate(gate({ status: 'rejected', resolver_id: 'member-1' }));
    expect((card()!.querySelector('[data-resolution]') as HTMLElement).getAttribute('data-resolution')).toBe('rejected');
  });

  it('a status the card has no word for keeps its raw word (nothing invented) with the neutral icon', async () => {
    await withGate(gate({ status: 'frozen' as GateItem['status'] }));
    const line = card()!.querySelector('[data-resolution]') as HTMLElement;
    expect(line.getAttribute('data-resolution')).toBe('voided');
    expect(card()!.textContent).toContain('frozen');
  });
});
