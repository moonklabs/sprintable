// @vitest-environment jsdom
//
// story #6c89e40d(페드루 PO 판정 2026-08-17, ⓑ) — doc-gate-section의 approve()가 note/
// evidence_viewed 없이 PATCH를 쐈다(dev 08-15 실사고, gate 5a34ef7f가 정확히 이 경로로
// 422). GateSignatureApproval을 canonical(gates/[id]/page.tsx·approvals-queue.tsx)과
// 동일 패턴으로 배선했는지 — high-risk gate에서 승인 버튼이 서명 다이얼로그를 열고,
// bare fetch(note 없는 approve)를 더 이상 쏘지 않는지 고정한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import type { GateItem } from '@/components/kanban/types';

const { useDashboardContextMock } = vi.hoisted(() => ({
  useDashboardContextMock: vi.fn(),
}));

vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

function gate(overrides: Partial<GateItem>): GateItem {
  return {
    id: 'gate-1',
    org_id: 'org-1',
    work_item_id: 'doc-1',
    work_item_type: 'doc',
    gate_type: 'doc_approval',
    status: 'pending',
    resolver_id: null,
    resolved_at: null,
    resolution_note: null,
    neutral_facts: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    source: 'gate',
    can_approve: true,
    risk_grade: 'high',
    ...overrides,
  };
}

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

async function renderSection(pendingGate: GateItem) {
  const { DocGateSection } = await import('./doc-gate-section');
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    if (typeof url === 'string' && url.includes('/api/gates?')) {
      return new Response(JSON.stringify([pendingGate]), { status: 200 });
    }
    if (typeof url === 'string' && url.includes('/revisions')) {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    if (typeof url === 'string' && url.includes('/team-members')) {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    // gate transition — 이 테스트 스위트가 감시할 호출.
    return new Response(JSON.stringify({ data: { ...pendingGate, status: 'approved' } }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);

  await act(async () => {
    root.render(wrap(
      <DocGateSection docId="doc-1" status="pending" onTransitioned={() => {}} />,
    ));
  });
  // load()의 3개 병렬 fetch가 끝날 때까지 마이크로태스크 flush.
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });

  return fetchMock;
}

describe('DocGateSection — story #3004(선생님 정책 확定) draft 상신은 결재자 지정이 전제', () => {
  async function renderDraftSection() {
    const { DocGateSection } = await import('./doc-gate-section');
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/api/gates?')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (typeof url === 'string' && url.includes('/revisions')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      if (typeof url === 'string' && url.includes('/team-members')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      if (typeof url === 'string' && url.includes('/api/org-members')) {
        return new Response(JSON.stringify({
          data: [
            { id: 'member-1', user_id: 'u-1', name: '나', role: 'owner' }, // 본인 — 제외돼야
            { id: 'member-2', user_id: 'u-2', name: '올리베이라군', role: 'admin' },
            { id: 'member-3', user_id: 'u-3', name: '멤버', role: 'member' }, // member — 제외돼야
          ],
        }), { status: 200 });
      }
      // /transition — 이 테스트 스위트가 감시할 호출.
      return new Response(JSON.stringify({ data: { id: 'doc-1', status: 'pending' } }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(wrap(
        <DocGateSection docId="doc-1" status="draft" onTransitioned={() => {}} />,
      ));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    return fetchMock;
  }

  it('"검토 요청" 클릭이 즉시 전이 대신 결재자 픽커를 연다(전이 fetch 미발생)', async () => {
    const fetchMock = await renderDraftSection();
    const reqBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(koMessages.docs.docGateRequestReview));
    await act(async () => { reqBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(fetchMock.mock.calls.some(([u]) => typeof u === 'string' && u.includes('/api/org-members'))).toBe(true);
    expect(fetchMock.mock.calls.some(([u]) => typeof u === 'string' && u.includes('/transition'))).toBe(false);
    // 취소 버튼이 뜬 것 자체가 픽커가 열렸다는 증거.
    const buttons = Array.from(container.querySelectorAll('button')).map((b) => b.textContent);
    expect(buttons.some((t) => t?.includes(koMessages.docs.docGateApproverPickerCancel))).toBe(true);
  });

  it('결재자 미선택이면 제출 버튼이 비활성(서버 400 왕복 없이 클라이언트에서 막는다)', async () => {
    await renderDraftSection();
    const reqBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(koMessages.docs.docGateRequestReview));
    await act(async () => { reqBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const submitBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(koMessages.docs.docGateRequestReview));
    expect(submitBtn?.hasAttribute('disabled')).toBe(true);
  });

  it('취소 클릭 시 픽커가 닫히고 draft CTA로 복귀한다', async () => {
    await renderDraftSection();
    const reqBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(koMessages.docs.docGateRequestReview));
    await act(async () => { reqBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const cancelBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(koMessages.docs.docGateApproverPickerCancel));
    await act(async () => { cancelBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const buttons = Array.from(container.querySelectorAll('button')).map((b) => b.textContent);
    expect(buttons.some((t) => t?.includes(koMessages.docs.docGateApproverPickerCancel))).toBe(false);
    expect(buttons.some((t) => t?.includes(koMessages.docs.docGateRequestReview))).toBe(true);
  });
});

describe('DocGateSection — high-risk(risk_grade=high) 승인은 서명 플로우를 거친다', () => {
  it('승인 버튼 클릭이 note 없는 bare transition을 쏘지 않고 서명 다이얼로그를 연다', async () => {
    const fetchMock = await renderSection(gate({}));

    const callCountBeforeClick = fetchMock.mock.calls.length;

    const approveBtn = Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('승인'));
    expect(approveBtn).toBeTruthy();

    await act(async () => {
      approveBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // 다이얼로그를 여는 것만으로는 어떤 fetch도 추가로 안 나가야 한다(예전 bare approve()는
    // 클릭 즉시 note 없이 transition을 쐈다 — 그 회귀가 다시 생기면 여기서 잡힌다).
    expect(fetchMock.mock.calls.length).toBe(callCountBeforeClick);

    // GateSignatureApproval의 근거 열람 체크박스/사유 textarea가 실제로 렌더됐는지(서명
    // 플로우로 정확히 분기됐다는 증거 — 단순히 "클릭해도 안 터진다"만으론 부족).
    // Dialog(base-ui)는 container 밖 document.body로 portal된다(approvals-queue.tsx의
    // 서명 Dialog와 동일 구조 — gates/[id]/page.test.tsx의 discuss dialog 케이스 참조).
    const checkbox = document.body.querySelector('[data-slot="dialog-content"] input[type="checkbox"]');
    const textarea = document.body.querySelector('[data-slot="dialog-content"] #gate-sig-reason');
    expect(checkbox).toBeTruthy();
    expect(textarea).toBeTruthy();
  });

  it('서명 다이얼로그에서 근거열람+사유 입력 후 승인하면 evidence_viewed:true+note가 실린다', async () => {
    const fetchMock = await renderSection(gate({}));

    const approveBtn = Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('승인'));
    await act(async () => {
      approveBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const checkbox = document.body.querySelector('[data-slot="dialog-content"] input[type="checkbox"]') as HTMLInputElement;
    const textarea = document.body.querySelector('[data-slot="dialog-content"] #gate-sig-reason') as HTMLTextAreaElement;

    await act(async () => {
      checkbox.click();
    });
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(textarea, '근거 확인함');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const signButtons = Array.from(document.body.querySelectorAll('[data-slot="dialog-content"] button'))
      .filter((b) => b.textContent?.includes('승인하고 서명'));
    expect(signButtons.length).toBeGreaterThan(0);
    const signBtn = signButtons[0]!;
    expect((signBtn as HTMLButtonElement).disabled).toBe(false);

    await act(async () => {
      signBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const transitionCall = fetchMock.mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('/transition'),
    );
    expect(transitionCall).toBeTruthy();
    const body = JSON.parse((transitionCall![1] as RequestInit).body as string);
    expect(body.status).toBe('approved');
    expect(body.evidence_viewed).toBe(true);
    expect(body.note).toBe('근거 확인함');
  });
});
