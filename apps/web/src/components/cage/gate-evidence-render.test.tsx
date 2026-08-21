// @vitest-environment jsdom
//
// story #2814 — 까디르 QA(PR#3244, HIGH): 순수함수 테스트(gate-evidence.test.ts)만으로는
// `GithubCheckSignal`이 실제로 SHA를 화면에 그리는지 못 잡는다 — `github_check_run_sha`가
// GateResponse 응답 스키마에서 누락돼 있었던 실 버그(FE는 항상 undefined를 받아 배지가
// 영구 누락)를 순수함수 테스트는 아예 건드리지 않았다. 이 파일은 실제 API 응답 shape
// 그대로(github_check_run_id·github_check_run_sha·approved_head_sha 세 필드 전부 포함) 마운트해
// SHA 텍스트가 실제로 DOM에 나타나는지 확인한다. [[feedback-render-test-over-source-grep]] 동형.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { GateEvidence } from './gate-evidence';
import { fetchWithAuth } from '@/lib/db/client';
import type { GateItem } from '@/components/kanban/types';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 까디르 QA(PR#3246, request_changes) — raw fetch는 no-new-raw-fetch 가드(#2687③/#… 401삼킴
// 정리) 위반. GithubRependingReason은 fetchWithAuth(@/lib/db/client)를 쓰므로 여기도 그걸 mock.
// 기본 응답은 빈 배열(원장 없음) — 상단 SHA 배지 describe 블록은 이 훅을 오버라이드하지 않고도
// (ghState==='in_progress'인 케이스에서) GithubRependingReason이 조용히 null을 그리게 한다.
vi.mock('@/lib/db/client', () => ({
  fetchWithAuth: vi.fn(async () => ({ ok: true, json: () => Promise.resolve([]) }) as Response),
}));

// backend/app/routers/gates.py GateResponse.model_validate(gate) — 실 API가 실제로 내려주는
// 필드 전부(from_attributes 경유, additive/nullable 필드도 값 채워서) 그대로 재현.
function realApiShapedGate(overrides: Partial<GateItem>): GateItem {
  return {
    id: 'gate-1',
    org_id: 'org-1',
    work_item_id: 'wi-1',
    work_item_type: 'story',
    gate_type: 'merge',
    status: 'pending',
    resolver_id: null,
    resolved_at: null,
    resolution_note: null,
    neutral_facts: null,
    created_at: '2026-08-19T00:00:00Z',
    updated_at: '2026-08-19T00:00:00Z',
    github_check_run_id: 987654321,
    github_check_run_sha: 'abc1234567890def1234567890abcdef1234567',
    approved_head_sha: null,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
});

describe('GateEvidence — GitHub check 배지 실 응답 shape 마운트(story #2814, 까디르 QA 회귀가드)', () => {
  it('github_check_run_sha가 실 API 응답처럼 채워져 있으면 짧은 SHA(7자)가 실제로 DOM에 나타난다', async () => {
    const gate = realApiShapedGate({ status: 'pending' });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    // status='pending'은 ghState==='in_progress'라 GithubRependingReason도 같이 마운트된다
    // (기본 mock=빈 배열) — 그 비동기 fetch까지 act로 감싸 flush(2단 도입 후 회귀 방지).
    await act(async () => { root.render(wrap(<GateEvidence gate={gate} />)); });

    expect(container.textContent).toContain('GitHub check');
    // 짧은 SHA(git 관례 7자) — 전체 40자 SHA가 아니라 잘린 값이 실제로 보여야 한다.
    expect(container.textContent).toContain('abc1234');
    expect(container.textContent).not.toContain('abc1234567890def1234567890abcdef1234567');
  });

  it('github_check_run_sha가 undefined(구버전 응답 재현)면 SHA 자리를 안 그린다 — 크래시 없이 정직 생략', async () => {
    const gate = realApiShapedGate({ status: 'pending', github_check_run_sha: undefined });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(wrap(<GateEvidence gate={gate} />)); });

    // check 상태 자체는 github_check_run_id만으로도 뜬다(githubCheckState는 sha 불필요) —
    // SHA 텍스트만 없어야 한다.
    expect(container.textContent).toContain('GitHub check');
    expect(container.textContent).not.toMatch(/SHA [0-9a-f]{7}/);
  });
});

// story #2814 2단(§5-② 그라운딩) — GithubRependingReason은 useEffect+fetch로 원장을 지연
// 로드한다. 순수함수 테스트로는 이 비동기 배선(호출 URL·최신 이벤트 필터링·실패 침묵)을
// 전혀 못 잡는다는 게 정확히 까디르 QA(PR#3244)가 증명한 클래스라 처음부터 마운트+fetch mock로
// 검증한다.
describe('GateEvidence — 재-pending 사유(원장 지연 로드, story #2814 2단)', () => {
  afterEach(() => {
    vi.mocked(fetchWithAuth).mockReset();
  });

  it('최신 원장 이벤트가 re_pending이면 새 SHA를 포함한 사유 문구가 실제로 DOM에 나타난다', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([
        { id: 'evt-2', repo_full_name: 'moonklabs/sprintable', pr_number: 3244, head_sha: 'def9876543210abc9876543210def9876543210', event_type: 're_pending', check_conclusion: null, created_at: '2026-08-19T02:00:00Z' },
        { id: 'evt-1', repo_full_name: 'moonklabs/sprintable', pr_number: 3244, head_sha: 'abc1234567890def1234567890abcdef1234567', event_type: 'published', check_conclusion: null, created_at: '2026-08-19T01:00:00Z' },
      ]),
    } as Response);

    const gate = realApiShapedGate({ status: 'pending', github_check_run_id: 987654321 });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(wrap(<GateEvidence gate={gate} />)); });

    expect(fetchWithAuth).toHaveBeenCalledWith('/api/gates/gate-1/github-check-events');
    expect(container.textContent).toContain('def9876');
  });

  // 2026-08-20 dev 라이브 AC2 재검 중 실측(gate bad5ad2c, PR#3249) — 새 커밋 감지 시 BE가
  // re_pending 기록 직후 그 SHA로 published까지 같은 처리 안에서 남겨, 원장 최신순 정렬 시
  // events[0]이 published·re_pending이 events[1]이 되는 순서가 실운영 기본값이었다. 이 케이스에서
  // events[0]만 보던 구버전은 사유 문구가 항상 죽어있었다(AC2 미충족) — 회귀 가드.
  it('원장 최신 이벤트가 published여도 그 직전이 re_pending이면 사유 문구가 나타난다(실측 순서)', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([
        { id: 'evt-2', repo_full_name: 'moonklabs/sprintable', pr_number: 3249, head_sha: 'b01c8c3d7fdf291090e3c3e4b69a0c8d3ab03981', event_type: 'published', check_conclusion: null, created_at: '2026-08-20T02:56:36.175894Z' },
        { id: 'evt-1', repo_full_name: 'moonklabs/sprintable', pr_number: 3249, head_sha: 'b01c8c3d7fdf291090e3c3e4b69a0c8d3ab03981', event_type: 're_pending', check_conclusion: null, created_at: '2026-08-20T02:56:36.114101Z' },
      ]),
    } as Response);

    const gate = realApiShapedGate({ status: 'pending', github_check_run_id: 987654321 });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(wrap(<GateEvidence gate={gate} />)); });

    expect(container.textContent).toContain('b01c8c3');
  });

  it('최신 원장 이벤트가 re_pending이 아니면(published 등) 사유 문구를 그리지 않는다', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([
        { id: 'evt-1', repo_full_name: 'moonklabs/sprintable', pr_number: 3244, head_sha: 'abc1234567890def1234567890abcdef1234567', event_type: 'published', check_conclusion: null, created_at: '2026-08-19T01:00:00Z' },
      ]),
    } as Response);

    const gate = realApiShapedGate({ status: 'pending', github_check_run_id: 987654321 });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(wrap(<GateEvidence gate={gate} />)); });

    expect(container.textContent).not.toContain('재-pending');
  });

  // story #2840(BE PR#3264 §2819 착지) — prior_sha가 채워진 re_pending 행은 "SHA A→B 무효화"
  // 완전 문구로 조립된다(AC1).
  it('re_pending 행에 prior_sha가 있으면 두 SHA 모두 담긴 완전 문구가 뜬다', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([
        { id: 'evt-1', repo_full_name: 'moonklabs/sprintable', pr_number: 3264, head_sha: 'def9876543210abc9876543210def9876543210', prior_sha: 'aaa1111111111111111111111111111111111a', event_type: 're_pending', check_conclusion: null, created_at: '2026-08-20T02:00:00Z' },
      ]),
    } as Response);

    const gate = realApiShapedGate({ status: 'pending', github_check_run_id: 987654321 });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(wrap(<GateEvidence gate={gate} />)); });

    expect(container.textContent).toContain('aaa1111');
    expect(container.textContent).toContain('def9876');
  });

  // story #2840 AC2 — prior_sha가 null(마이그레이션 이전 행·published/resolved 행)이면 두 SHA를
  // 지어내지 않고 기존 단축 문구("새 SHA만")로 정직하게 폴백한다(no-fiction).
  it('re_pending 행에 prior_sha가 null이면 prior SHA를 지어내지 않고 단축 문구로 폴백한다', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([
        { id: 'evt-1', repo_full_name: 'moonklabs/sprintable', pr_number: 3244, head_sha: 'def9876543210abc9876543210def9876543210', prior_sha: null, event_type: 're_pending', check_conclusion: null, created_at: '2026-08-19T02:00:00Z' },
      ]),
    } as Response);

    const gate = realApiShapedGate({ status: 'pending', github_check_run_id: 987654321 });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(wrap(<GateEvidence gate={gate} />)); });

    expect(container.textContent).toContain('def9876');
    expect(container.textContent).not.toContain('에서 SHA');
  });

  it('원장 조회가 실패해도(네트워크/404) 카드는 붕괴하지 않고 GithubCheckSignal은 그대로 보인다', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({ ok: false, status: 500 } as Response);

    const gate = realApiShapedGate({ status: 'pending', github_check_run_id: 987654321 });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(wrap(<GateEvidence gate={gate} />)); });

    expect(container.textContent).toContain('GitHub check');
    expect(container.textContent).not.toContain('재-pending');
  });

  it('success/failure 등 재-pending 여지 없는 상태는 원장 조회 자체를 하지 않는다(불필요 왕복 방지)', async () => {
    const gate = realApiShapedGate({ status: 'approved', github_check_run_id: 987654321 });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(wrap(<GateEvidence gate={gate} />)); });

    expect(fetchWithAuth).not.toHaveBeenCalled();
  });
});

// story #2862(loop-closure P2-B FE, BE PR#3277) — hypothesis_outcome_confirm 게이트의
// neutral_facts.draft_target/draft_actual/draft_reason 렌더.
describe('GateEvidence — 측정 판정 초안 렌더(story #2862)', () => {
  function draftGate(overrides: Partial<GateItem> = {}, neutralFacts: Record<string, unknown> = {}): GateItem {
    return realApiShapedGate({
      gate_type: 'hypothesis_outcome_confirm',
      work_item_type: 'hypothesis',
      status: 'pending',
      github_check_run_id: null,
      neutral_facts: { draft_target: 'verified', draft_actual: 42, draft_reason: '목표치 초과 달성', ...neutralFacts },
      ...overrides,
    });
  }

  it('draft_target/draft_actual/draft_reason이 실제로 DOM에 나타난다(AC1)', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(wrap(<GateEvidence gate={draftGate()} />)); });

    expect(container.textContent).toContain(koMessages.cage.hypothesisDraftBadge);
    expect(container.textContent).toContain(koMessages.cage.hypothesisDraftTargetVerified);
    expect(container.textContent).toContain('42');
    expect(container.textContent).toContain('목표치 초과 달성');
  });

  // AC1/AC2 — 초안은 destructive/success가 아니라 info 톤 하나로만 표현한다(맞음이든 틀림이든
  // 확정처럼 보이면 안 된다).
  it('destructive/success 색을 쓰지 않고 info 톤만 쓴다(AC1/AC2 — verified/falsified 무관)', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(wrap(<GateEvidence gate={draftGate({}, { draft_target: 'falsified' })} />));
    });

    expect(container.innerHTML).not.toMatch(/bg-destructive|text-destructive/);
    expect(container.innerHTML).not.toMatch(/bg-success|text-success/);
    expect(container.querySelector('.bg-info\\/10')).toBeTruthy();
  });

  it('draft_reason이 없으면 근거 없음을 정직하게 알린다(AC3 — 지어내지 않음)', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(wrap(<GateEvidence gate={draftGate({}, { draft_reason: null })} />));
    });

    expect(container.textContent).toContain(koMessages.cage.hypothesisDraftReasonMissing);
  });

  it('draft_target이 계약 밖 값이면(BE 위반 방어) 초안 블록을 그리지 않는다(no-fiction)', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(wrap(<GateEvidence gate={draftGate({}, { draft_target: 'unknown_target' })} />));
    });

    expect(container.textContent).not.toContain(koMessages.cage.hypothesisDraftBadge);
  });
});
