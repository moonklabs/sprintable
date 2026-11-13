// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { TopBarProvider } from '@/components/nav/top-bar-context';
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
        memo_id: null, story_id: null, trigger: 'manual', model: null,
        llm_provider: null, llm_provider_key: null, status: 'failed', duration_ms: 1000,
        llm_call_count: 1, input_tokens: null, output_tokens: null, cost_usd: null,
        computed_cost_cents: 0, per_run_cap_cents: null, billing_notes: [],
        result_summary: null, error_message: '실패했습니다', last_error_code: 'E1',
        retry_count: 0, max_retries: 3, next_retry_at: null, failure_disposition: null,
        started_at: null, finished_at: null,
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

// story #2513 — 카디르 QA 발견: 실패 배너의 아이콘이 variant 색을 잃는 회귀. story 4911에서 배너가 ds Banner(tone=failed)로 바뀌어, 같은 가드를 새 부품에서 지킨다 —
// 실패 run은 role=alert인 failed 배너를 갖고, 그 아이콘은 failed 색(text-ds-failed)이다(색만으로 뜻을 싣지 않도록 «오류» 글자 · 테두리와 함께).
describe('AgentRunDetail — 실패 배너 아이콘 색 유지 (story #2513 회귀가드 · story 4911 ds Banner)', () => {
  it('실패 run의 failed 배너 아이콘이 text-ds-failed를 갖는다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => failedRunResponse()));
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <TopBarProvider><AgentRunDetail runId="run-1" locale="ko" onBack={() => {}} /></TopBarProvider>
        </NextIntlClientProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const alertEl = container.querySelector('[role="alert"][data-slot="ds-banner"]');
    expect(alertEl).not.toBeNull();
    expect(alertEl?.getAttribute('data-tone')).toBe('failed');
    const icon = alertEl?.querySelector('[class*="text-ds-failed"]');
    expect(icon).not.toBeNull();
  });
});
