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
import type { GateItem } from '@/components/kanban/types';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
  it('github_check_run_sha가 실 API 응답처럼 채워져 있으면 짧은 SHA(7자)가 실제로 DOM에 나타난다', () => {
    const gate = realApiShapedGate({ status: 'pending' });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => { root.render(wrap(<GateEvidence gate={gate} />)); });

    expect(container.textContent).toContain('GitHub check');
    // 짧은 SHA(git 관례 7자) — 전체 40자 SHA가 아니라 잘린 값이 실제로 보여야 한다.
    expect(container.textContent).toContain('abc1234');
    expect(container.textContent).not.toContain('abc1234567890def1234567890abcdef1234567');
  });

  it('github_check_run_sha가 undefined(구버전 응답 재현)면 SHA 자리를 안 그린다 — 크래시 없이 정직 생략', () => {
    const gate = realApiShapedGate({ status: 'pending', github_check_run_sha: undefined });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => { root.render(wrap(<GateEvidence gate={gate} />)); });

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
  it('최신 원장 이벤트가 re_pending이면 새 SHA를 포함한 사유 문구가 실제로 DOM에 나타난다', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([
        { id: 'evt-2', repo_full_name: 'moonklabs/sprintable', pr_number: 3244, head_sha: 'def9876543210abc9876543210def9876543210', event_type: 're_pending', check_conclusion: null, created_at: '2026-08-19T02:00:00Z' },
        { id: 'evt-1', repo_full_name: 'moonklabs/sprintable', pr_number: 3244, head_sha: 'abc1234567890def1234567890abcdef1234567', event_type: 'published', check_conclusion: null, created_at: '2026-08-19T01:00:00Z' },
      ]),
    });
    vi.stubGlobal('fetch', fetchMock);

    const gate = realApiShapedGate({ status: 'pending', github_check_run_id: 987654321 });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(wrap(<GateEvidence gate={gate} />)); });

    expect(fetchMock).toHaveBeenCalledWith('/api/gates/gate-1/github-check-events');
    expect(container.textContent).toContain('def9876');
    vi.unstubAllGlobals();
  });

  it('최신 원장 이벤트가 re_pending이 아니면(published 등) 사유 문구를 그리지 않는다', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([
        { id: 'evt-1', repo_full_name: 'moonklabs/sprintable', pr_number: 3244, head_sha: 'abc1234567890def1234567890abcdef1234567', event_type: 'published', check_conclusion: null, created_at: '2026-08-19T01:00:00Z' },
      ]),
    });
    vi.stubGlobal('fetch', fetchMock);

    const gate = realApiShapedGate({ status: 'pending', github_check_run_id: 987654321 });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(wrap(<GateEvidence gate={gate} />)); });

    expect(container.textContent).not.toContain('재-pending');
    vi.unstubAllGlobals();
  });

  it('원장 조회가 실패해도(네트워크/404) 카드는 붕괴하지 않고 GithubCheckSignal은 그대로 보인다', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal('fetch', fetchMock);

    const gate = realApiShapedGate({ status: 'pending', github_check_run_id: 987654321 });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(wrap(<GateEvidence gate={gate} />)); });

    expect(container.textContent).toContain('GitHub check');
    expect(container.textContent).not.toContain('재-pending');
    vi.unstubAllGlobals();
  });

  it('success/failure 등 재-pending 여지 없는 상태는 원장 조회 자체를 하지 않는다(불필요 왕복 방지)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const gate = realApiShapedGate({ status: 'approved', github_check_run_id: 987654321 });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(wrap(<GateEvidence gate={gate} />)); });

    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
