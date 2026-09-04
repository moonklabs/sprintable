// @vitest-environment jsdom
//
// story #2272 — workflow-line/withdraw가 형제 fallback-notify와 같은 흐름(stuck-handoff)
// 안에서 끝까지 되는지 검증한다. 되돌릴 수 없는 조작이라 confirm 단계를 강제하는 것도 확認.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { StuckHandoffSection } from './stuck-handoff-section';
import type { WorkflowLineStepRun } from '@/components/kanban/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function withIntl(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

function stuckStep(): WorkflowLineStepRun {
  return {
    id: 'run-1', status: 'pending', from_status: null, to_status: 'in-progress', mode: 'auto',
    routing_decision: null, routing_reason: null, blocking_reason: null, gate_id: null,
    delivery_status: 'timed_out', delivery_error: null, correlation_id: 'corr-1',
    sla_due_at: null, started_at: null, engine_degraded: false, grandfathered: false,
    observability_note: null, h1_evidence: null, approvers: [], last_event: null,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubFetch(statusRoute: WorkflowLineStepRun, withdrawImpl: (body: unknown) => Response) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/workflow-line/status')) {
      return new Response(JSON.stringify({ active: statusRoute }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/workflow-line/withdraw')) {
      const body = init?.body ? JSON.parse(init.body as string) : null;
      return withdrawImpl(body);
    }
    return new Response('{}', { status: 200 });
  }));
}

async function renderSection() {
  await act(async () => { root.render(withIntl(<StuckHandoffSection storyId="story-1" />)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

function findButtonByText(text: string) {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(text));
}

describe('StuckHandoffSection — withdraw(story #2272)', () => {
  it('첫 클릭은 confirm 배너만 띄우고 fetch(withdraw)는 아직 안 부른다', async () => {
    const withdrawSpy = vi.fn(() => new Response(JSON.stringify({ status: 'withdrawn' }), { status: 200 }));
    stubFetch(stuckStep(), withdrawSpy);
    await renderSection();

    const btn = findButtonByText('요청 철회');
    expect(btn).toBeDefined();
    await act(async () => { btn!.click(); });

    expect(withdrawSpy).not.toHaveBeenCalled();
    expect(container.textContent).toContain('철회하면 되돌릴 수 없습니다');
  });

  it('취소를 누르면 confirm이 닫히고 fetch(withdraw)는 끝내 안 불린다', async () => {
    const withdrawSpy = vi.fn(() => new Response(JSON.stringify({ status: 'withdrawn' }), { status: 200 }));
    stubFetch(stuckStep(), withdrawSpy);
    await renderSection();

    await act(async () => { findButtonByText('요청 철회')!.click(); });
    await act(async () => { findButtonByText('취소')!.click(); });

    expect(withdrawSpy).not.toHaveBeenCalled();
    expect(findButtonByText('요청 철회')).toBeDefined();
  });

  it('철회 확인을 누르면 step_run_id를 실어 POST하고 성공 시 철회됨 상태로 전환된다', async () => {
    const withdrawSpy = vi.fn(() => new Response(JSON.stringify({ status: 'withdrawn' }), { status: 200 }));
    stubFetch(stuckStep(), withdrawSpy);
    await renderSection();

    await act(async () => { findButtonByText('요청 철회')!.click(); });
    await act(async () => { findButtonByText('철회 확인')!.click(); await Promise.resolve(); await Promise.resolve(); });

    expect(withdrawSpy).toHaveBeenCalledTimes(1);
    const [body] = withdrawSpy.mock.calls[0] as unknown as [{ step_run_id: string }];
    expect(body.step_run_id).toBe('run-1');
    expect(container.textContent).toContain('철회됨');
    expect(findButtonByText('요청 철회')).toBeUndefined();
  });

  it('실패 시 실패 토스트를 띄우고 다시 시도할 수 있다(idle로 복귀)', async () => {
    const withdrawSpy = vi.fn(() => new Response('{}', { status: 409 }));
    stubFetch(stuckStep(), withdrawSpy);
    await renderSection();

    await act(async () => { findButtonByText('요청 철회')!.click(); });
    await act(async () => { findButtonByText('철회 확인')!.click(); await Promise.resolve(); await Promise.resolve(); });

    expect(container.textContent).toContain('철회에 실패했습니다');
    expect(findButtonByText('요청 철회')).toBeDefined();
  });

  // story 3466 후속(무효 유틸 4곳) — idle 버튼(「소유자에게 재전달」)이 no-op
  // text-destructive-foreground 대신 실 렌더 색을 갖는지.
  it('⭐idle 버튼(소유자에게 재전달)이 text-white dark:text-proof-bg를 쓰고 무효 유틸이 안 남았다', async () => {
    stubFetch(stuckStep(), () => new Response('{}', { status: 200 }));
    await renderSection();
    const btn = findButtonByText('소유자에게 재전달');
    expect(btn?.className).toContain('text-white');
    expect(btn?.className).toContain('dark:text-proof-bg');
    expect(btn?.className).not.toContain('text-destructive-foreground');
  });
});
