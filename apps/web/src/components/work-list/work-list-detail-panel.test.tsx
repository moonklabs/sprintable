// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { WorkListDetailPanel } from './work-list-detail-panel';
import type { WorkListRow } from './derive-work-list';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// story #3845 — ArtifactSection/EvidenceSection은 각자 자기 fetch·자기 테스트 스위트를
// 가진 무거운 컴포넌트다(story-detail-panel.tsx 기존 재사용 관례) — 이 패널의 테스트
// 관심사는 "그 컴포넌트에 올바른 props를 넘기는가"뿐이라 얇은 stub으로 대체한다(실
// fetch·실 렌더는 각 컴포넌트 자신의 스위트가 이미 검증).
vi.mock('@/components/verify/evidence-section', () => ({
  EvidenceSection: (props: { workItemId: string; workItemType: string; selfReported: unknown }) => (
    <div data-testid="stub-evidence-section" data-work-item-id={props.workItemId} data-work-item-type={props.workItemType} data-self-reported={String(props.selfReported)} />
  ),
}));
vi.mock('@/components/canvas/artifact-section', () => ({
  ArtifactSection: (props: { storyId: string }) => <div data-testid="stub-artifact-section" data-story-id={props.storyId} />,
}));

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.stubGlobal('fetch', fetchMock);

const { dashboardContextRef } = vi.hoisted(() => ({
  dashboardContextRef: { current: { currentMemberType: 'human' as 'human' | 'agent' | undefined } },
}));
vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => dashboardContextRef.current,
}));

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

function baseRow(overrides: Partial<WorkListRow> = {}): WorkListRow {
  return {
    id: 'row-1', kind: 'task', workItemType: 'task', workItemId: 'task-1',
    title: '일 제목', ownerName: '디디', isDelegated: false, lowRisk: false, artifactCount: 0,
    state: 'awaiting_approval',
    ...overrides,
  };
}

function jsonResponse(data: unknown, init: { status?: number } = {}) {
  return {
    ok: (init.status ?? 200) < 300,
    status: init.status ?? 200,
    json: async () => ({ data }),
  };
}

/** 이 패널이 마운트 시 병렬로 던지는 4개 fetch(story·hypotheses·backlinks·gates)를
 * url 패턴으로 분기해 응답한다 — 순서에 기대지 않는다(Promise.all 등가, 실 구현이
 * 순서를 바꿔도 이 테스트가 안 깨진다). */
function mockFetchRoutes(routes: {
  story?: unknown;
  hypotheses?: unknown[];
  docs?: unknown[];
  gates?: unknown[];
  transitionStatus?: number;
}) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST' && url.includes('/transition')) {
      return jsonResponse({ id: 'g1', status: 'approved' }, { status: routes.transitionStatus ?? 200 });
    }
    if (url.startsWith('/api/stories/') && url.endsWith('/backlinks?source_type=doc')) {
      return jsonResponse(routes.docs ?? []);
    }
    if (url.startsWith('/api/stories/')) {
      return jsonResponse(routes.story ?? null);
    }
    if (url.startsWith('/api/hypotheses')) {
      return jsonResponse(routes.hypotheses ?? []);
    }
    if (url.startsWith('/api/gates')) {
      return jsonResponse(routes.gates ?? []);
    }
    return jsonResponse(null, { status: 404 });
  });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  dashboardContextRef.current = { currentMemberType: 'human' };
  fetchMock.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.restoreAllMocks();
});

async function mountPanel(row: WorkListRow = baseRow(), storyId = 'story-1') {
  await act(async () => {
    root.render(wrap(
      <WorkListDetailPanel row={row} storyId={storyId} storyTitle="스토리 제목" goalTitle="목표 제목" onClose={() => {}} />,
    ));
  });
  // 4개 fetch(async 체인)가 정착할 때까지 마이크로태스크 몇 바퀴 더 돈다.
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

describe('WorkListDetailPanel — 헤더', () => {
  it('제목·「어디에 속하나」·담당·상태를 그대로 그린다', async () => {
    mockFetchRoutes({});
    await mountPanel(baseRow({ title: '문서 초안 작성', ownerName: '유나' }));
    expect(container.textContent).toContain('문서 초안 작성');
    expect(container.querySelector('[data-testid="panel-belongs-to"]')?.textContent).toContain('목표 제목');
    expect(container.querySelector('[data-testid="panel-belongs-to"]')?.textContent).toContain('스토리 제목');
    expect(container.querySelector('[data-testid="panel-assignee"]')?.textContent).toContain('유나');
    expect(container.querySelector('[data-testid="panel-state"]')?.textContent).toContain(koMessages.workList.stateAwaitingApproval);
  });

  it('담당 없음(ownerName=null)이면 「배정 없음」(지어내지 않는다)', async () => {
    mockFetchRoutes({});
    await mountPanel(baseRow({ ownerName: null }));
    expect(container.querySelector('[data-testid="panel-assignee"]')?.textContent).toContain(koMessages.workList.panelAssigneeNone);
  });
});

describe('WorkListDetailPanel — 탭→데이터 매핑', () => {
  it('⭐근거 탭 — 가설 목록+EvidenceSection에 정확히 이 storyId·work_item_type=story가 실린다', async () => {
    mockFetchRoutes({
      hypotheses: [{ id: 'h1', statement: '가설 문장 A', status: 'active' }],
      story: { self_reported: true, human_verified: null, human_verified_by: null, human_verified_at: null },
    });
    await mountPanel(baseRow(), 'story-42');
    expect(container.querySelector('[data-testid="panel-hypotheses-list"]')?.textContent).toContain('가설 문장 A');
    const stub = container.querySelector('[data-testid="stub-evidence-section"]');
    expect(stub?.getAttribute('data-work-item-id')).toBe('story-42');
    expect(stub?.getAttribute('data-work-item-type')).toBe('story');
    expect(stub?.getAttribute('data-self-reported')).toBe('true');
  });

  it('⭐문서 탭 — backlinks 응답 doc 제목만 뜨고, 다른 탭(가설·산출물) 데이터는 안 섞인다', async () => {
    mockFetchRoutes({
      docs: [{ id: 'ref1', doc: { id: 'doc1', title: '연결된 문서 제목' }, still_exists: true }],
      hypotheses: [{ id: 'h1', statement: '가설 문장 A', status: 'active' }],
    });
    await mountPanel();
    // Base UI Tabs는 활성 패널만 DOM에 싣는다(마운트 유지 아님) — 문서 탭을 눌러야
    // panel-docs-list가 실제로 나타난다.
    await act(async () => { (container.querySelector('[data-testid="panel-tab-docs"]') as HTMLElement).click(); });
    const docsList = container.querySelector('[data-testid="panel-docs-list"]');
    expect(docsList?.textContent).toContain('연결된 문서 제목');
    // 문서 목록 안에 가설 문장이 섞여 들어오지 않는다(탭 분리 확認).
    expect(docsList?.textContent).not.toContain('가설 문장 A');
  });

  it('문서 탭 — 0건이면 「연결된 문서가 없어요」', async () => {
    mockFetchRoutes({ docs: [] });
    await mountPanel();
    await act(async () => { (container.querySelector('[data-testid="panel-tab-docs"]') as HTMLElement).click(); });
    expect(container.querySelector('[data-testid="panel-docs-empty"]')?.textContent).toBe(koMessages.workList.panelEmptyDocs);
  });

  it('⭐산출물 탭 — ArtifactSection에 정확히 이 storyId가 실린다', async () => {
    mockFetchRoutes({});
    await mountPanel(baseRow(), 'story-99');
    await act(async () => { (container.querySelector('[data-testid="panel-tab-artifacts"]') as HTMLElement).click(); });
    expect(container.querySelector('[data-testid="stub-artifact-section"]')?.getAttribute('data-story-id')).toBe('story-99');
  });
});

describe('WorkListDetailPanel — 위험 pill(gate_type/risk에서만)', () => {
  it('pending gate 0건이면 위험 pill 0(placeholder 아님)', async () => {
    mockFetchRoutes({ gates: [] });
    await mountPanel();
    expect(container.querySelector('[data-testid="panel-risk"]')).toBeNull();
  });

  it('risk_grade=high면 고위험 뱃지+문장', async () => {
    mockFetchRoutes({ gates: [{ id: 'g1', gate_type: 'doc_approval', risk_grade: 'high', status: 'pending', work_item_id: 'task-1', work_item_type: 'task' }] });
    await mountPanel();
    expect(container.querySelector('[data-testid="panel-risk"]')?.textContent).toContain(koMessages.workList.riskBadgeHigh);
  });
});

describe('WorkListDetailPanel — 주 액션 라벨 매핑', () => {
  it('gate_type=doc_approval·risk=null → 「승인」', async () => {
    mockFetchRoutes({ gates: [{ id: 'g1', gate_type: 'doc_approval', risk_grade: null, status: 'pending', work_item_id: 'task-1', work_item_type: 'task' }] });
    await mountPanel();
    expect(container.querySelector('[data-testid="panel-primary-action"]')?.textContent).toBe(koMessages.workList.actionApprove);
  });

  it('gate_type=external_publish → 「승인하고 서명」', async () => {
    mockFetchRoutes({ gates: [{ id: 'g1', gate_type: 'external_publish', risk_grade: null, status: 'pending', work_item_id: 'task-1', work_item_type: 'task' }] });
    await mountPanel();
    expect(container.querySelector('[data-testid="panel-primary-action"]')?.textContent).toBe(koMessages.workList.actionApproveAndSign);
  });

  it('risk_grade=high → 「승인하고 서명」(gate_type 무관)', async () => {
    mockFetchRoutes({ gates: [{ id: 'g1', gate_type: 'doc_approval', risk_grade: 'high', status: 'pending', work_item_id: 'task-1', work_item_type: 'task' }] });
    await mountPanel();
    expect(container.querySelector('[data-testid="panel-primary-action"]')?.textContent).toBe(koMessages.workList.actionApproveAndSign);
  });
});

describe('WorkListDetailPanel — 에이전트 뷰어 403 회피', () => {
  it('⭐currentMemberType=agent면 pending gate가 있어도 주 액션 버튼 자체가 없다', async () => {
    dashboardContextRef.current = { currentMemberType: 'agent' };
    mockFetchRoutes({ gates: [{ id: 'g1', gate_type: 'doc_approval', risk_grade: null, status: 'pending', work_item_id: 'task-1', work_item_type: 'task' }] });
    await mountPanel();
    expect(container.querySelector('[data-testid="panel-primary-action"]')).toBeNull();
  });
});

describe('WorkListDetailPanel — transition 성공/403', () => {
  it('⭐성공 — 클릭하면 승인 완료 문구가 뜨고 버튼이 사라진다', async () => {
    mockFetchRoutes({
      gates: [{ id: 'g1', gate_type: 'doc_approval', risk_grade: null, status: 'pending', work_item_id: 'task-1', work_item_type: 'task' }],
      transitionStatus: 200,
    });
    await mountPanel();
    const btn = container.querySelector('[data-testid="panel-primary-action"]') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    await act(async () => { btn.click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(container.querySelector('[data-testid="panel-approved-notice"]')?.textContent).toBe(koMessages.workList.actionApproved);
    expect(container.querySelector('[data-testid="panel-primary-action"]')).toBeNull();
  });

  it('⭐403 — 크래시 없이 「에이전트 계정은 승인할 수 없어요」로 우아하게 처리(깨진 화면 0)', async () => {
    mockFetchRoutes({
      gates: [{ id: 'g1', gate_type: 'doc_approval', risk_grade: null, status: 'pending', work_item_id: 'task-1', work_item_type: 'task' }],
      transitionStatus: 403,
    });
    await mountPanel();
    const btn = container.querySelector('[data-testid="panel-primary-action"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(container.querySelector('[data-testid="panel-transition-error"]')?.textContent).toBe(koMessages.workList.transitionForbidden);
    // 버튼은 남아 있다(재시도 가능 — 승인완료로 잘못 넘어가지 않는다).
    expect(container.querySelector('[data-testid="panel-primary-action"]')).not.toBeNull();
  });
});

describe('WorkListDetailPanel — 답하기(conversation_id 갭)', () => {
  it('conversation_id 소스가 없어 항상 비노출(지어내지 않는다 — 실측 갭)', async () => {
    mockFetchRoutes({ gates: [{ id: 'g1', gate_type: 'doc_approval', risk_grade: null, status: 'pending', work_item_id: 'task-1', work_item_type: 'task' }] });
    await mountPanel();
    expect(container.querySelector('[data-testid="panel-reply-action"]')).toBeNull();
  });
});
