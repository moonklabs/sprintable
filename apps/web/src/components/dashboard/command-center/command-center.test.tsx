// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../messages/ko.json';
import { CommandCenter } from './command-center';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// story #2338 — fleet.status_breakdown 실측 shape(command_center.py 실제 반환, 독립 원본).
const OVERVIEW_PAYLOAD = {
  data: {
    scope: 'org',
    project_status: {
      epics: [], outcome: { hit: 0, total: 0 }, recent_changes: [],
      risk: { blocked: 0, failed_runs: 0, overdue: { status: 'pending_data' } },
      cycle_time: { avg_days: null, sample: 0 },
      contribution: { agent: 0, human: 0, unassigned: 0 },
      cost_trend: { points: [], total_cost_usd: 0, delta_pct: null },
    },
    fleet: { total_agents: 14, status_breakdown: { online: 9, offline: 0, working: 5 } },
  },
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url.includes('/api/dashboard/overview')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(OVERVIEW_PAYLOAD) });
    }
    if (url.includes('/api/dashboard/my-actions')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: { action_queue: { scope: 'project', items: [] }, attention: { scope: 'project', items: [], pending: [] }, is_clear: true } }),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) });
  }));
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

describe('CommandCenter fleet badge (story #2338 — isPending 죽은 분기)', () => {
  it('renders the real online/working counts, not the fleet-breakdown-pending placeholder', async () => {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <CommandCenter />
        </NextIntlClientProvider>,
      );
    });
    // effect가 fetch 3건을 기다리는 동안 한 틱 더 flush.
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toContain('온라인 9');
    expect(container.textContent).toContain('작업중 5');
    expect(container.textContent).not.toContain('상태 집계 준비중');
  });
});
