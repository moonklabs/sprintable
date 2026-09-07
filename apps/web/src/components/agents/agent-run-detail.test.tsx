// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { AgentRunDetail } from './agent-run-detail';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function failedRunResponse() {
  return {
    ok: true,
    json: async () => ({
      data: {
        id: 'run-1', agent_id: 'agent-1', agent_name: '테스트 에이전트', deployment_id: null,
        session_id: null, memo_id: null, story_id: null, trigger: 'manual', model: null,
        llm_provider: null, llm_provider_key: null, status: 'failed', duration_ms: 1000,
        llm_call_count: 1, input_tokens: null, output_tokens: null, cost_usd: null,
        computed_cost_cents: 0, per_run_cap_cents: null, billing_notes: [],
        result_summary: null, error_message: '실패했습니다', last_error_code: 'E1',
        retry_count: 0, max_retries: 3, next_retry_at: null, failure_disposition: null,
        tool_call_history: null, tool_audit_trail: null, continuity_debug: null,
        memory_compaction_policy: null, started_at: null, finished_at: null,
        created_at: '2026-08-07T00:00:00Z',
      },
    }),
  };
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

// story #2513 — 카디르 QA 발견: alert.tsx 글자가 text-foreground로 통일된 후, 색을
// 명시하지 않은 아이콘은 부모의 currentColor를 상속해 variant 색(destructive=red)을
// 잃는다. 이 파일엔 테스트가 없어 그 회귀를 잡을 게 없었다 — 이 테스트가 그 자리.
describe('AgentRunDetail — 실패 배너 아이콘 색 유지 (story #2513 회귀가드)', () => {
  it('실패 run의 destructive 배너 AlertTriangle이 text-destructive를 갖는다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => failedRunResponse()));
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <AgentRunDetail runId="run-1" locale="ko" onBack={() => {}} />
        </NextIntlClientProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const alertEl = container.querySelector('[role="alert"]');
    expect(alertEl).not.toBeNull();
    const icon = alertEl?.querySelector('svg');
    expect(icon?.getAttribute('class')).toContain('text-destructive');
  });
});

// story #3677(FE·대비·確定, 유나 표① 2026-09-07) — text-destructive/80 상시 2자리가
// 두 테마 다 AA 미달(3.76 타임라인 카드·3.82 이중 알파 bg-white/3 카드)이었다. 알파를
// 뺀 text-destructive로 교체 — 뮤테이션 표적(디디 자체 검증): /80을 되돌리면 이
// 테스트가 RED.
function failedRunWithErrorsResponse() {
  return {
    ok: true,
    json: async () => ({
      data: {
        id: 'run-1', agent_id: 'agent-1', agent_name: '테스트 에이전트', deployment_id: null,
        session_id: null, memo_id: null, story_id: null, trigger: 'manual', model: null,
        llm_provider: null, llm_provider_key: null, status: 'failed', duration_ms: 1000,
        llm_call_count: 1, input_tokens: null, output_tokens: null, cost_usd: null,
        computed_cost_cents: 0, per_run_cap_cents: null, billing_notes: [],
        result_summary: null, error_message: '실패했습니다', last_error_code: 'E1',
        retry_count: 0, max_retries: 3, next_retry_at: null, failure_disposition: null,
        tool_call_history: [
          { type: 'tool', toolName: 'search', error: '타임라인 카드 에러' },
        ],
        tool_audit_trail: [
          {
            id: 'audit-1', run_id: 'run-1', session_id: null, event_type: 'tool.denied',
            severity: 'error', summary: '거부됨', payload: { error: '감사 카드 에러' },
            created_by: null, created_at: '2026-08-07T00:00:00Z', actor_name: null,
          },
        ],
        continuity_debug: null, memory_compaction_policy: null,
        started_at: null, finished_at: null, created_at: '2026-08-07T00:00:00Z',
      },
    }),
  };
}

describe('AgentRunDetail — text-destructive 알파 제거(story #3677 AA 미달 픽스)', () => {
  it('타임라인 카드·도구 감사 카드의 에러 문구 둘 다 text-destructive/80이 아니라 text-destructive다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => failedRunWithErrorsResponse()));
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <AgentRunDetail runId="run-1" locale="ko" onBack={() => {}} />
        </NextIntlClientProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('타임라인 카드 에러');
    expect(container.textContent).toContain('감사 카드 에러');

    const allClassNames = Array.from(container.querySelectorAll('[class]'))
      .map((el) => el.getAttribute('class') ?? '');
    const destructiveTextEls = allClassNames.filter((c) => /\btext-destructive\b/.test(c));
    expect(destructiveTextEls.length).toBeGreaterThan(0);
    expect(allClassNames.some((c) => c.includes('text-destructive/80'))).toBe(false);
  });
});
