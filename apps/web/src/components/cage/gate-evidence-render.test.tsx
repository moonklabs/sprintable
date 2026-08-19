// @vitest-environment jsdom
//
// story #2814 — 까디르 QA(PR#3244, HIGH): 순수함수 테스트(gate-evidence.test.ts)만으로는
// `GithubCheckSignal`이 실제로 SHA를 화면에 그리는지 못 잡는다 — `github_check_run_sha`가
// GateResponse 응답 스키마에서 누락돼 있었던 실 버그(FE는 항상 undefined를 받아 배지가
// 영구 누락)를 순수함수 테스트는 아예 건드리지 않았다. 이 파일은 실제 API 응답 shape
// 그대로(github_check_run_id·github_check_run_sha·approved_head_sha 세 필드 전부 포함) 마운트해
// SHA 텍스트가 실제로 DOM에 나타나는지 확인한다. [[feedback-render-test-over-source-grep]] 동형.
import { describe, it, expect, afterEach } from 'vitest';
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
