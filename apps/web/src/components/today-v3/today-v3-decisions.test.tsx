// @vitest-environment jsdom
//
// story #3964(E-UX-OVERHAUL·「오늘」 구현 4/N) — AC2/AC3 실동작(액션×source 매핑·
// 모아 승인 부분 실패·고위험 제외·성공 뒤 재조회 콜백) 단위 테스트. TodayV3Decisions
// 는 이미 파싱된 TodayNeedsMeItem[]만 받으므로 BE raw 모양 재현은 불요(derive-
// today.test.ts가 그 파싱을 전담).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { TodayV3Decisions } from './today-v3-decisions';
import type { TodayNeedsMeItem } from '@/components/org-briefing/derive-today';

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
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: null }) });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

const base: TodayNeedsMeItem = {
  id: 'g1', source: 'gate', state: 'signature', risk: 'high',
  workItemType: 'channel_post', workItemId: 'w1', workItemTitle: '블로그 글 발행',
  requestedByName: null, reason: null, createdAt: '2026-09-17T00:00:00Z', conversationId: null,
};

async function mount(items: TodayNeedsMeItem[], opts?: { isAdminOrOwner?: boolean; onActionSuccess?: () => void }) {
  const onActionSuccess = opts?.onActionSuccess ?? vi.fn();
  await act(async () => {
    root.render(wrap(
      <TodayV3Decisions
        items={items} count={items.length}
        isAdminOrOwner={opts?.isAdminOrOwner ?? false}
        onActionSuccess={onActionSuccess}
      />,
    ));
  });
  return onActionSuccess;
}

describe('TodayV3Decisions — 고위험 gate 카드(서명 링크+변경요청+보류)', () => {
  it('⭐서명은 여전히 /gates/{id} 링크(근거열람 플로우는 이 카드 스코프 밖)', async () => {
    await mount([base]);
    const link = container.querySelector('a[href="/gates/g1"]');
    expect(link).not.toBeNull();
  });

  it('⭐변경 요청 — 다이얼로그에서 사유 입력 후 제출하면 POST /transition {status:rejected}', async () => {
    const onDone = await mount([base]);
    const btn = container.querySelector('[data-testid="today-v3-request-changes-action"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    const textarea = document.body.querySelector('[data-testid="today-v3-reason-textarea"]') as HTMLTextAreaElement;
    const textareaSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      textareaSetter.call(textarea, '근거가 부족해요');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const submit = document.body.querySelector('[data-testid="today-v3-reason-submit"]') as HTMLButtonElement;
    await act(async () => { submit.click(); });
    await act(async () => { await Promise.resolve(); });
    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/gates/g1/transition');
    expect(call).toBeDefined();
    const body = JSON.parse(call![1].body as string);
    expect(body).toEqual({ status: 'rejected', note: '근거가 부족해요', evidence_viewed: false, reviewed_head_sha: null });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('⭐보류 — admin/owner에게만 버튼이 보인다(비활성 아니라 렌더 자체가 없음)', async () => {
    await mount([base], { isAdminOrOwner: false });
    expect(container.querySelector('[data-testid="today-v3-hold-action"]')).toBeNull();
  });

  it('⭐보류 — admin/owner면 버튼이 보이고 제출 시 POST /gates/{id}/hold', async () => {
    await mount([base], { isAdminOrOwner: true });
    const btn = container.querySelector('[data-testid="today-v3-hold-action"]') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    await act(async () => { btn.click(); });
    const submit = document.body.querySelector('[data-testid="today-v3-reason-submit"]') as HTMLButtonElement;
    // 보류는 사유 선택(빈 값도 제출 가능).
    await act(async () => { submit.click(); });
    await act(async () => { await Promise.resolve(); });
    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/gates/g1/hold');
    expect(call).toBeDefined();
  });
});

describe('TodayV3Decisions — hitl 답 카드(승인/반려 + 선택 응답)', () => {
  const hitl: TodayNeedsMeItem = {
    ...base, id: 'h1', source: 'hitl', state: 'answer', risk: 'low',
    workItemTitle: 'YouTube 영상 올리기', reason: '챕터를 3개로 나눌까요?',
  };

  it('⭐승인 — 응답 미입력이면 response_text 키 자체가 안 실린다', async () => {
    const onDone = await mount([hitl]);
    const btn = container.querySelector('[data-testid="today-v3-hitl-approve-action"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    await act(async () => { await Promise.resolve(); });
    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/v1/hitl-requests/h1');
    expect(call).toBeDefined();
    expect(JSON.parse(call![1].body as string)).toEqual({ status: 'approved' });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('⭐반려 — 응답을 입력하면 response_text로 실린다', async () => {
    await mount([hitl]);
    const input = container.querySelector('[data-testid="today-v3-hitl-response-input"]') as HTMLInputElement;
    const inputSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      inputSetter.call(input, '아니요, 2개로');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const btn = container.querySelector('[data-testid="today-v3-hitl-reject-action"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    await act(async () => { await Promise.resolve(); });
    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/v1/hitl-requests/h1');
    expect(JSON.parse(call![1].body as string)).toEqual({ status: 'rejected', response_text: '아니요, 2개로' });
  });
});

describe('TodayV3Decisions — workflow_step은 자리만(클릭 0)', () => {
  it('⭐비활성 버튼 — 클릭해도 fetch 호출 0', async () => {
    const workflowItem: TodayNeedsMeItem = {
      ...base, id: 'a1', source: 'workflow_step', state: 'approval', risk: 'low',
      workItemTitle: '워크플로 라인 승인',
    };
    await mount([workflowItem]);
    const btn = container.querySelector('[data-testid="today-v3-workflow-step-placeholder-action"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    const before = fetchMock.mock.calls.length;
    await act(async () => { btn.click(); });
    expect(fetchMock.mock.calls.length).toBe(before);
  });
});

describe('TodayV3Decisions — 저위험 모아 승인(순차 전이·부분 실패·고위험 제외)', () => {
  const gateLow1: TodayNeedsMeItem = { ...base, id: 'g2', state: 'approval', risk: 'low', workItemTitle: '태그 정리' };
  const gateLow2: TodayNeedsMeItem = { ...base, id: 'g3', state: 'approval', risk: 'low', workItemTitle: '스토리 이동' };
  const hitlLow: TodayNeedsMeItem = {
    ...base, id: 'h2', source: 'hitl', state: 'approval', risk: 'low', workItemTitle: '뉴스레터 발송',
  };

  it('⭐순차 전이 — gate는 /transition, hitl은 PATCH hitl-requests, 둘 다 approved', async () => {
    const onDone = await mount([base, gateLow1, hitlLow]);
    const btn = container.querySelector('[data-testid="today-v3-bulk-approve-action"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const gateCall = fetchMock.mock.calls.find((c) => c[0] === '/api/gates/g2/transition');
    const hitlCall = fetchMock.mock.calls.find((c) => c[0] === '/api/v1/hitl-requests/h2');
    expect(gateCall).toBeDefined();
    expect(JSON.parse(gateCall![1].body as string).status).toBe('approved');
    expect(hitlCall).toBeDefined();
    expect(JSON.parse(hitlCall![1].body as string).status).toBe('approved');
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('⭐고위험은 모아 승인에 절대 포함되지 않는다(g1=high는 개별 카드로만)', async () => {
    await mount([base, gateLow1]);
    const btn = container.querySelector('[data-testid="today-v3-bulk-approve-action"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    await act(async () => { await Promise.resolve(); });
    const highCall = fetchMock.mock.calls.find((c) => c[0] === '/api/gates/g1/transition');
    expect(highCall).toBeUndefined();
  });

  it('⭐부분 실패 — 1건 실패 시 실패 건수 문장이 뜬다', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/gates/g2/transition') return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ data: null }) };
    });
    await mount([gateLow1, gateLow2]);
    const btn = container.querySelector('[data-testid="today-v3-bulk-approve-action"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('1');
  });
});
