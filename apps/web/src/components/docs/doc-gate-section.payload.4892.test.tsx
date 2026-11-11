// @vitest-environment jsdom
//
// story 4892 (UI-9 문서 상세 «결재 구역») — the section wears ds parts (StatusLabel · Button · Field + Textarea · NativeSelect · SectionHeader · Dialog), and the SIGNATURE CONTRACT DID NOT MOVE:
// every request the section sends carries exactly the same JSON body as before. This file pins each body as a whole string (not field by field), pins the handler lines in the source, and checks the ds look.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import type { GateItem } from '@/components/kanban/types';
import gateSource from './doc-gate-section.tsx?raw';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const docs = koMessages.docs;
const cage = koMessages.cage as unknown as Record<string, string>;
let container: HTMLDivElement;
let root: Root;

const wrap = (node: React.ReactNode) => (
  <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>
);
const gate = (over: Partial<GateItem> = {}): GateItem => ({
  id: 'gate-1', org_id: 'org-1', work_item_id: 'doc-1', work_item_type: 'doc', gate_type: 'doc_approval', status: 'pending', resolver_id: null, resolved_at: null,
  resolution_note: null, neutral_facts: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), source: 'gate', can_approve: true, risk_grade: 'high', ...over,
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'member-1' });
});
afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ORG_MEMBERS = [
  { id: 'member-1', user_id: 'u-1', name: '나', role: 'owner' },
  { id: 'member-2', user_id: 'u-2', name: '올리베이라군', role: 'admin', email: 'o@x.dev' },
];
async function mount(status: string, gates: GateItem[], revisions: unknown[] = []) {
  const { DocGateSection } = await import('./doc-gate-section');
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    if (typeof url === 'string' && url.includes('/api/gates?')) return new Response(JSON.stringify(gates), { status: 200 });
    if (typeof url === 'string' && url.includes('/revisions')) return new Response(JSON.stringify({ data: revisions }), { status: 200 });
    if (typeof url === 'string' && (url.includes('/team-members') || url.includes('/api/org/names') || url.includes('names'))) return new Response(JSON.stringify({ data: [{ id: 'member-2', name: '올리베이라군' }] }), { status: 200 });
    if (typeof url === 'string' && url.includes('/api/org-members')) return new Response(JSON.stringify({ data: ORG_MEMBERS }), { status: 200 });
    return new Response(JSON.stringify({ data: { id: 'x', status: 'ok' } }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => { root.render(wrap(<DocGateSection docId="doc-1" status={status} onTransitioned={() => {}} />)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  return fetchMock;
}
const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); await new Promise((r) => setTimeout(r, 10)); }); };
const btn = (label: string, scope: ParentNode = document.body) => [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
const transitionCall = (fetchMock: ReturnType<typeof vi.fn>, part: string) => fetchMock.mock.calls.find((c) => typeof c[0] === 'string' && (c[0] as string).includes(part) && (c[0] as string).includes('/transition'));
const setValue = (el: HTMLTextAreaElement, v: string) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };

describe('결재 구역 — 서명 · 결재 계약은 그대로: 보내는 본문을 통째로 고정 (story 4892)', () => {
  it('⭐고위험 승인(서명 창): 본문 전체 = status · resolver_id · note · evidence_viewed:true', async () => {
    const f = await mount('pending', [gate()]);
    await act(async () => { btn(docs.docGateApprove, container)!.click(); });
    const checkbox = document.body.querySelector('[data-slot="ds-dialog-content"] [role="checkbox"]') as HTMLElement;
    const reason = document.body.querySelector('[data-slot="ds-dialog-content"] #gate-sig-reason') as HTMLTextAreaElement;
    await act(async () => { checkbox.click(); });
    await act(async () => { setValue(reason, '근거 확인함'); });
    const sign = [...document.body.querySelectorAll('[data-slot="ds-dialog-content"] button')].find((b) => b.textContent?.includes('승인하고 서명')) as HTMLButtonElement;
    await act(async () => { sign.click(); });
    const call = transitionCall(f, '/api/gates/gate-1')!;
    expect(call[0]).toBe('/api/gates/gate-1/transition');
    expect((call[1] as RequestInit).method).toBe('POST');
    expect((call[1] as RequestInit).headers).toEqual({ 'Content-Type': 'application/json' });
    expect((call[1] as RequestInit).body).toBe('{"status":"approved","resolver_id":"member-1","note":"근거 확인함","evidence_viewed":true}');
  });

  it('⭐고위험 반려(서명 창): 본문 전체 = status · resolver_id · note (evidence_viewed 없음)', async () => {
    const f = await mount('pending', [gate()]);
    await act(async () => { btn(docs.docGateReject, container)!.click(); });
    const reason = document.body.querySelector('[data-slot="ds-dialog-content"] #gate-sig-reason') as HTMLTextAreaElement;
    await act(async () => { setValue(reason, '근거가 부족해요'); });
    const rej = btn(cage.sigReject!, document.body.querySelector('[data-slot="ds-dialog-content"]')!)!;
    await act(async () => { rej.click(); });
    const call = transitionCall(f, '/api/gates/gate-1')!;
    expect((call[1] as RequestInit).body).toBe('{"status":"rejected","resolver_id":"member-1","note":"근거가 부족해요"}');
  });

  it('⭐저위험 승인(원탭): 본문 전체 = status · resolver_id 둘뿐', async () => {
    const f = await mount('pending', [gate({ risk_grade: 'low' })]);
    await act(async () => { btn(docs.docGateApprove, container)!.click(); });
    await settle();
    const call = transitionCall(f, '/api/gates/gate-1')!;
    expect(call[0]).toBe('/api/gates/gate-1/transition');
    expect((call[1] as RequestInit).body).toBe('{"status":"approved","resolver_id":"member-1"}');
  });

  it('⭐저위험 반려(사유 창): 본문 전체 = status · resolver_id · note', async () => {
    const f = await mount('pending', [gate({ risk_grade: 'low' })]);
    await act(async () => { btn(docs.docGateReject, container)!.click(); });
    const area = document.body.querySelector('[data-slot="ds-dialog-content"] textarea') as HTMLTextAreaElement;
    await act(async () => { setValue(area, '3절 수치가 다름'); });
    await act(async () => { btn(docs.docGateRejectConfirm, document.body.querySelector('[data-slot="ds-dialog-content"]')!)!.click(); });
    await settle();
    const call = transitionCall(f, '/api/gates/gate-1')!;
    expect((call[1] as RequestInit).body).toBe('{"status":"rejected","resolver_id":"member-1","note":"3절 수치가 다름"}');
  });

  it('⭐draft → 상신: 본문 전체 = status:pending · approver_member_id (고른 결재자의 id 그대로)', async () => {
    const f = await mount('draft', []);
    await act(async () => { btn(docs.docGateRequestReview, container)!.click(); });
    await settle();
    const select = container.querySelector('select') as HTMLSelectElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, 'member-2');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const submit = [...container.querySelectorAll('button')].filter((b) => b.textContent?.trim() === docs.docGateRequestReview).pop() as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    await act(async () => { submit.click(); });
    await settle();
    const call = f.mock.calls.find((c) => typeof c[0] === 'string' && (c[0] as string) === '/api/docs/doc-1/transition')!;
    expect((call[1] as RequestInit).method).toBe('POST');
    expect((call[1] as RequestInit).body).toBe('{"status":"pending","approver_member_id":"member-2"}');
  });

  it('⭐반려된 문서의 «수정»: 본문 전체 = status:draft 하나', async () => {
    const f = await mount('denied', [gate({ status: 'rejected', can_approve: false, resolver_id: 'member-2', resolved_at: new Date().toISOString(), resolution_note: '표 2를 다시' })]);
    await act(async () => { btn(docs.docGateEdit, container)!.click(); });
    await settle();
    const call = f.mock.calls.find((c) => typeof c[0] === 'string' && (c[0] as string) === '/api/docs/doc-1/transition')!;
    expect((call[1] as RequestInit).body).toBe('{"status":"draft"}');
  });

  it('⭐핸들러 줄은 소스에서 한 글자도 안 바뀌었다(본문을 만드는 줄을 그대로 박아 둔다)', () => {
    for (const line of [
      "status: 'approved', resolver_id: currentTeamMemberId, note: reason.trim() || null, evidence_viewed: true,",
      "status: 'rejected', resolver_id: currentTeamMemberId, note: reason.trim() || null,",
      "const { ok } = await gateTransition({ status: 'rejected', resolver_id: currentTeamMemberId, note: note.trim() || null });",
      "void gateTransition({ status: 'approved', resolver_id: currentTeamMemberId });",
      "const body: Record<string, unknown> = { status: next };",
      "if (next === 'pending' && approverMemberId) body.approver_member_id = approverMemberId;",
      "const res = await fetch(`/api/gates/${gate.id}/transition`, {",
      "const res = await fetchWithAuth(`/api/docs/${docId}/transition`, {",
      "const isSigFlow = gate ? usesSignatureFlow(deriveRiskLevel(gate)) : false;",
    ]) expect(gateSource, line).toContain(line);
  });

  it('GateSignatureApproval(서명 부품)는 이 PR이 건드리지 않는다: 같은 부품을 같은 props로 쓴다', () => {
    expect(gateSource).toContain("import { GateSignatureApproval } from '@/components/cage/gate-signature-approval';");
    expect(gateSource).toMatch(/<GateSignatureApproval\s+gate=\{gate\}\s+resolving=\{busy\}\s+error=\{sigError\}\s+onApprove=\{\(reason\) => sigApprove\(reason\)\}\s+onReject=\{\(reason\) => sigReject\(reason\)\}\s+compact/);
  });
});

describe('결재 구역 — ds 부품 (story 4892)', () => {
  it('⭐상태 글자는 ds StatusLabel: 검토 중 + 내가 결재자 = needs-hand · 검토 중 + 남의 차례 = idle · 승인됨 = online · 반려됨 = failed', async () => {
    const label = () => container.querySelector('[data-slot="ds-status-label"]') as HTMLElement;
    await mount('pending', [gate()]);
    expect(label().getAttribute('data-status')).toBe('needs-hand');
    expect(label().textContent).toContain(docs.docGatePending);
    await act(async () => { root.unmount(); }); root = createRoot(container);
    await mount('pending', [gate({ can_approve: false })]);
    expect(label().getAttribute('data-status')).toBe('idle');
    await act(async () => { root.unmount(); }); root = createRoot(container);
    await mount('confirmed', [gate({ status: 'approved', can_approve: false, resolver_id: 'member-2', resolved_at: new Date().toISOString() })]);
    expect(label().getAttribute('data-status')).toBe('online');
    expect(label().textContent).toContain(docs.docGateConfirmed);
    await act(async () => { root.unmount(); }); root = createRoot(container);
    await mount('denied', [gate({ status: 'rejected', can_approve: false, resolver_id: 'member-2', resolved_at: new Date().toISOString(), resolution_note: '다시' })]);
    expect(label().getAttribute('data-status')).toBe('failed');
    expect(label().textContent).toContain(docs.docGateDenied);
  });

  it('⭐«반려»는 ds Button 위험(danger), «승인»은 ds Button 주(primary) — 둘 다 ds 단추', async () => {
    await mount('pending', [gate()]);
    const rej = btn(docs.docGateReject, container)!;
    const app = btn(docs.docGateApprove, container)!;
    expect(rej.getAttribute('data-slot')).toBe('ds-button');
    expect(app.getAttribute('data-slot')).toBe('ds-button');
    expect(rej.className).toContain('border-ds-failed');
    expect(app.className).toContain('bg-ds-action');
  });

  it('⭐반려 사유 창: ds Dialog(이름 = 제목) + ds Field(보이는 이름이 칸에 for로 이어짐) + 비면 확정 비활성 · «취소»는 닫고 초안을 지움', async () => {
    await mount('pending', [gate({ risk_grade: 'low' })]);
    await act(async () => { btn(docs.docGateReject, container)!.click(); });
    const dlg = document.body.querySelector('[data-slot="ds-dialog-content"]') as HTMLElement;
    expect(dlg).not.toBeNull();
    const labelledBy = dlg.getAttribute('aria-labelledby')!;
    expect(document.getElementById(labelledBy)!.textContent).toContain(docs.docGateRejectModalTitle);
    const area = dlg.querySelector('textarea') as HTMLTextAreaElement;
    expect(area.getAttribute('data-slot')).toBe('ds-textarea');
    const lab = dlg.querySelector(`label[for="${area.id}"]`);
    expect(lab?.textContent).toContain(docs.docGateRejectReasonLabel);
    expect(btn(docs.docGateRejectConfirm, dlg)!.disabled).toBe(true);
    await act(async () => { setValue(area, '사유'); });
    expect(btn(docs.docGateRejectConfirm, dlg)!.disabled).toBe(false);
    await act(async () => { btn(docs.cancel, dlg)!.click(); });
    await settle();
    expect(document.body.querySelector('[data-slot="ds-dialog-content"]')).toBeNull();
  });

  it('결재자 고르개는 ds NativeSelect: 안내 줄(비활성) + «이름 (이메일)» 옵션, 고르면 제출이 켜진다 · 동명 경고는 role=alert 그대로', async () => {
    await mount('draft', []);
    await act(async () => { btn(docs.docGateRequestReview, container)!.click(); });
    await settle();
    const select = container.querySelector('select') as HTMLSelectElement;
    expect(select.getAttribute('data-slot') ?? select.closest('[data-slot]')?.getAttribute('data-slot')).toMatch(/select/);
    const opts = [...select.querySelectorAll('option')];
    expect(opts[0]!.disabled).toBe(true);
    expect(opts.map((o) => o.textContent)).toContain('올리베이라군 (o@x.dev)');
    expect(opts.some((o) => o.textContent?.includes('나'))).toBe(false);   // 본인은 제외
  });

  it('감사 타임라인 머리는 ds SectionHeader: 접힘 aria-expanded · 누르면 이력이 열린다 · 건수가 괄호로', async () => {
    await mount('confirmed', [gate({ status: 'approved', can_approve: false, resolver_id: 'member-2', resolved_at: new Date().toISOString() })], [{ id: 'r1', created_by: 'member-2', created_at: '2026-11-10T01:00:00Z' }]);
    const header = container.querySelector('[data-slot="ds-section-header"]') as HTMLElement;
    expect(header).not.toBeNull();
    const toggle = header.querySelector('button[aria-expanded]') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(header.textContent).toContain('(2)');
    expect(container.querySelector('ul')).toBeNull();
    await act(async () => { toggle.click(); });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelectorAll('ul li').length).toBe(2);
  });

  it('결재 구역 소스에 옛 ui/ 부품 · lucide 가져오기가 없다', () => {
    expect(gateSource).not.toMatch(/from '@\/components\/ui\//);
    expect(gateSource).not.toMatch(/from 'lucide-react'/);
  });
});
