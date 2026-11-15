// @vitest-environment jsdom
//
// story 4891 (UI-8 · settings › 조직 · piece ⑤a) — the org gate-policy card on ds parts: the approver pickers are labelled native selects that carry the chosen member, a change goes into the saved PUT body (merge and recipe fields stay apart),
// the posture buttons keep aria-pressed, the result line is a ds Banner (saved = status, refused = alert), and the loading state is a named skeleton group.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { OrgGatePolicySection } from './org-gate-policy-section';
import { resetOrgMembersCacheForTests } from '@/hooks/use-member-name-fallback';

vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ({}) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let puts: Record<string, unknown>[];
let putStatus: { ok: boolean; body: unknown };
beforeEach(() => {
  puts = []; putStatus = { ok: true, body: {} };
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/gate-config/policy' && init?.method === 'PUT') { puts.push(JSON.parse(String(init.body))); return { ok: putStatus.ok, status: putStatus.ok ? 200 : 422, json: async () => putStatus.body }; }
    if (url === '/api/gate-config/policy') return { ok: true, status: 200, json: async () => ({ data: { id: 'p', org_id: 'o', posture: 'balanced', merge_gate_default_approver_member_id: 'member-1', recipe_gate_default_approver_member_id: null, created_at: 'x', updated_at: 'x' } }) };
    if (url === '/api/org-members/eligible-approvers') return { ok: true, status: 200, json: async () => ({ data: [{ id: 'member-1', user_id: 'u1', name: '송윤재', email: 'a@x.com', role: 'owner' }, { id: 'member-2', user_id: 'u2', name: '페드루', email: 'p@x.com', role: 'admin' }] }) };
    throw new Error('unexpected fetch: ' + url);
  }));
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); resetOrgMembersCacheForTests(); });

const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };
async function draw(canEdit = true) {
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><OrgGatePolicySection canEdit={canEdit} /></NextIntlClientProvider>); });
  await flush();
}
const selects = () => [...container.querySelectorAll('select')] as HTMLSelectElement[];
const choose = async (el: HTMLSelectElement, value: string) => { await act(async () => { el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); }); };
const saveBtn = () => [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.orgGatePolicy.save) as HTMLButtonElement;
const press = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); }); await flush(); };
const t = koMessages.orgGatePolicy;

describe('[SID:4891] OrgGatePolicySection on ds parts', () => {
  it('a ds card with the title as h2; two labelled native selects; the merge picker shows the set approver, the recipe picker «미지정»', async () => {
    await draw();
    expect(container.querySelector('[data-slot="ds-card"] h2')?.textContent).toBe(t.title);
    const [merge, recipe] = selects();
    expect(container.querySelector(`label[for="${merge!.id}"]`)?.textContent).toBe(t.approverLabel);
    expect(container.querySelector(`label[for="${recipe!.id}"]`)?.textContent).toBe(t.recipeApproverLabel);
    expect(merge!.selectedOptions[0]?.textContent).toContain('송윤재');
    expect(recipe!.selectedOptions[0]?.textContent).toBe(t.approverUnset);
  });

  it('a changed pick of each picker, and a posture press, go into the PUT body — the two approver fields stay apart', async () => {
    await draw();
    const [merge, recipe] = selects();
    await choose(merge!, '');
    await choose(recipe!, 'member-2');
    const permissive = [...container.querySelectorAll('[role="group"] button')].find((b) => b.textContent === t.posturePermissive)!;
    await press(permissive);
    expect(permissive.getAttribute('aria-pressed')).toBe('true');
    await press(saveBtn());
    expect(puts).toEqual([{ posture: 'permissive', merge_gate_default_approver_member_id: null, recipe_gate_default_approver_member_id: 'member-2' }]);
  });

  it('saved → an info Banner (status); refused (422) → the server\'s own sentence in a failed Banner (alert)', async () => {
    await draw();
    await press(saveBtn());
    expect(container.querySelector('[data-slot="ds-banner"]')?.getAttribute('role')).toBe('status');
    expect(container.querySelector('[data-slot="ds-banner"]')?.textContent).toContain(t.saved);
    putStatus = { ok: false, body: { detail: '에이전트는 승인자가 될 수 없어요' } };
    await press(saveBtn());
    const banner = container.querySelector('[data-slot="ds-banner"]')!;
    expect(banner.getAttribute('role')).toBe('alert');
    expect(banner.textContent).toContain('에이전트는 승인자가 될 수 없어요');
  });

  it('while the policy is read: a named skeleton group and no controls', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/gate-config/policy') { await gate; return { ok: true, status: 200, json: async () => ({ data: null }) }; }
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    });
    await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><OrgGatePolicySection canEdit /></NextIntlClientProvider>); });
    const g = container.querySelector('[data-slot="ds-skeleton-group"]')!;
    expect(g.getAttribute('aria-label')).toBe(koMessages.common.loading);
    expect(container.querySelector('select')).toBeNull();
    await act(async () => { release(); }); await flush();
  });

  it('while the candidate list is still being read: an UNSET picker keeps reading «미지정»; a picker whose approver is set but not in the list yet reads «불러오는 중» (not a raw id)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/gate-config/policy') return { ok: true, status: 200, json: async () => ({ data: { id: 'p', org_id: 'o', posture: 'balanced', merge_gate_default_approver_member_id: 'member-1', recipe_gate_default_approver_member_id: null, created_at: 'x', updated_at: 'x' } }) };
      if (url === '/api/org-members/eligible-approvers') { await gate; return { ok: true, status: 200, json: async () => ({ data: [] }) }; }
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    });
    await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><OrgGatePolicySection canEdit /></NextIntlClientProvider>); });
    await flush();
    const [merge, recipe] = selects();
    expect(recipe!.selectedOptions[0]?.textContent).toBe(t.approverUnset);
    expect(merge!.selectedOptions[0]?.textContent).toBe(t.approverLoading);
    expect(merge!.disabled && recipe!.disabled).toBe(true);
    await act(async () => { release(); }); await flush();
  });
});
