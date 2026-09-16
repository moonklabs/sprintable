// @vitest-environment jsdom
//
// story #3970(E-UX-OVERHAUL·「오늘」 구현 5/N) — 「정지」 실동작(취소 가능 필터·
// {reason} 바디 byte 계약·403 사람 문장·409 재조회·성공 재조회) 단위 테스트.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { TodayV3AgentProgress } from './today-v3-agent-progress';
import type { TodayAgentProgressItem } from '@/components/org-briefing/derive-today';

const fetchMock = vi.fn();
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

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

const runningItem: TodayAgentProgressItem = {
  runId: 'r1', agentName: '미르코', workItemTitle: '빌드 가드', status: 'running',
  startedAt: '2026-09-17T00:00:00Z', cancel: null,
};

async function mount(items: TodayAgentProgressItem[], onActionSuccess = vi.fn()) {
  await act(async () => {
    root.render(wrap(<TodayV3AgentProgress items={items} onActionSuccess={onActionSuccess} />));
  });
  return onActionSuccess;
}

function submitDialog() {
  const btn = document.body.querySelector('[data-testid="today-v3-reason-submit"]') as HTMLButtonElement;
  return act(async () => { btn.click(); });
}

describe('TodayV3AgentProgress — 취소 가능 필터', () => {
  it('⭐취소 가능 status(running)면 정지 버튼이 활성', async () => {
    await mount([runningItem]);
    const btn = container.querySelector('[data-testid="today-v3-stop-action"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it('⭐취소 불가 status(completed)면 정지 버튼이 비활성', async () => {
    await mount([{ ...runningItem, status: 'completed' }]);
    const btn = container.querySelector('[data-testid="today-v3-stop-action"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('⭐이미 cancel 필드가 있으면 버튼 대신 「정지 요청됨」 라벨', async () => {
    await mount([{ ...runningItem, status: 'cancel_requested', cancel: { requestedAt: '2026-09-17T00:01:00Z', reason: null, state: 'requested' } }]);
    expect(container.querySelector('[data-testid="today-v3-stop-action"]')).toBeNull();
    expect(container.querySelector('[data-testid="today-v3-stop-requested-label"]')?.textContent).toBe('정지 요청됨');
  });
});

describe('TodayV3AgentProgress — 실동작({reason} 바디·성공 재조회)', () => {
  it('⭐성공 — POST /api/agent-runs/{id}/cancel {reason}·재조회 1회', async () => {
    const onDone = await mount([runningItem]);
    const btn = container.querySelector('[data-testid="today-v3-stop-action"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    await submitDialog();
    await act(async () => { await Promise.resolve(); });
    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/agent-runs/r1/cancel');
    expect(call).toBeDefined();
    expect(JSON.parse(call![1].body as string)).toEqual({ reason: null });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('⭐403 — 사람 문장 1(raw BE 문구 노출 0)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, json: async () => ({}) });
    await mount([runningItem]);
    const btn = container.querySelector('[data-testid="today-v3-stop-action"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    await submitDialog();
    await act(async () => { await Promise.resolve(); });
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe('멈출 권한이 없어요');
  });

  it('⭐409 — 오류문장 없이 재조회(이미 종결·이미 요청됨=서버 진실 반영)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 409, json: async () => ({}) });
    const onDone = await mount([runningItem]);
    const btn = container.querySelector('[data-testid="today-v3-stop-action"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    await submitDialog();
    await act(async () => { await Promise.resolve(); });
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('[role="alert"]')).toBeNull();
  });
});
