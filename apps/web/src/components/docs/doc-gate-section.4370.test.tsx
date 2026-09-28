// @vitest-environment jsdom
/**
 * story #4370 — 문서 게이트 반려 사유(여러 줄)는 게이트별 초안: 예전엔 부모 상태라 창을 닫는 건 버텼지만 페이지를 떠나면(언마운트)
 * 사라졌다. 이제 다시 와서 반려를 열면 그대로 · 보이는 «취소»와 반려 성공에서만 지운다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import type { GateItem } from '@/components/kanban/types';
import { DocGateSection } from './doc-gate-section';

vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ({ currentTeamMemberId: 'member-1' }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const docs = koMessages.docs as unknown as Record<string, string>;
const GATE = {
  id: 'gate-1', org_id: 'org-1', work_item_id: 'doc-1', work_item_type: 'doc', gate_type: 'doc_approval', status: 'pending',
  resolver_id: null, resolved_at: null, resolution_note: null, neutral_facts: null,
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(), source: 'gate', can_approve: true, risk_grade: 'low',
} as GateItem;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/gates?')) return new Response(JSON.stringify([GATE]), { status: 200 });
    if (url.includes('/revisions') || url.includes('/team-members')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
    return new Response(JSON.stringify({ data: { ...GATE, status: 'rejected' } }), { status: 200 });
  }));
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 30)); }); };
const button = (label: string) => [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement;
const reason = () => document.body.querySelector<HTMLTextAreaElement>(`textarea[placeholder="${docs.docGateRejectReasonPlaceholder}"]`);

async function visit() {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <DocGateSection docId="doc-1" status="pending" onTransitioned={() => {}} />
      </NextIntlClientProvider>,
    );
  });
  await settle();
}
async function leave() { await act(async () => { root.render(<></>); }); }
async function openReject() { await act(async () => { button(docs.docGateReject).click(); }); }
async function type(text: string) {
  const el = reason()!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('문서 게이트 반려 사유 초안(story #4370)', () => {
  it('페이지를 떠났다 와도 남고 · «취소»는 지운다', async () => {
    await visit();
    await openReject();
    await type('3절 수치가 원자료와 다름\n표 2 다시 확인');
    await leave();
    await visit();
    await openReject();
    expect(reason()!.value).toBe('3절 수치가 원자료와 다름\n표 2 다시 확인');
    await act(async () => { button(docs.cancel).click(); });
    await openReject();
    expect(reason()!.value).toBe('');
  });

  it('반려 성공은 지운다', async () => {
    await visit();
    await openReject();
    await type('반려 사유');
    const dialog = document.body.querySelector('[data-slot="dialog-content"]')!;  // 섹션 버튼도 같은 «반려» — 창 안의 확정 버튼
    const confirm = [...dialog.querySelectorAll('button')].find((b) => b.textContent?.trim() === docs.docGateRejectConfirm)!;
    await act(async () => { confirm.click(); });
    await settle();
    expect(reason()).toBeNull();
    await leave();
    await visit();
    await openReject();
    expect(reason()!.value).toBe('');
  });
});
