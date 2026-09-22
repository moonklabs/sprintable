// @vitest-environment jsdom
//
// story #3972 AC1 그라운딩(페드루 PO 확認) — 이 카드는 옛 approval-request-card.tsx의
// 인라인 승인을 재사용하지 않는다: 「서명」은 항상 링크(인라인 0)·「변경 요청」만
// 인라인(gate/transition + buildGateTransitionBody).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ChatV3EventCard } from './chat-v3-event-card';

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

const approvalTarget = { work_item_type: 'channel_post', work_item_id: 'w1', gate_id: 'g1', actions: ['approve', 'reject'] };

async function mount(onDone = vi.fn(), isInTodayQueue = true, todayV3Enabled = true) {
  await act(async () => {
    root.render(wrap(<ChatV3EventCard approvalTarget={approvalTarget} content="발행 승인을 올려요" isInTodayQueue={isInTodayQueue} todayV3Enabled={todayV3Enabled} onDone={onDone} />));
  });
  return onDone;
}

describe('ChatV3EventCard', () => {
  // 페드루 PO 지시(2026-09-17 00:08Z, PR #4370 CHANGES) — 서명은 「오늘」 한 곳뿐(시안
  // SSOT) → 링크는 `/today`(게이트 상세 아님).
  it('⭐서명은 /today 링크(인라인 승인 0 — 「오늘」 큐에 있을 때만 보인다)', async () => {
    await mount(vi.fn(), true);
    const link = container.querySelector('a[href="/today"]');
    expect(link).not.toBeNull();
    expect(link?.textContent).toBe('「오늘」에서 서명');
  });

  // 막다른 길 방지(페드루 PO) — 이 게이트가 보는 사람의 오늘 큐에 없으면 서명 버튼
  // 자체를 숨긴다(눌러도 거기 없는 링크를 안 보여준다).
  it('⭐오늘 큐에 없으면 서명 버튼이 안 보인다(변경 요청만 남는다)', async () => {
    await mount(vi.fn(), false);
    expect(container.querySelector('[data-testid="chat-v3-event-card-sign"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-v3-event-card-request-changes"]')).not.toBeNull();
  });

  // story #3972 CHANGES(페드루 PO 2026-09-17 01:54Z, 실결함) — TODAY_V3_ENABLED
  // OFF면 /today가 404 — 옛 게이트 상세로 되돌린다.
  it('⭐todayV3Enabled=false면 서명 링크가 /gates/{gate_id}로 간다(404 방지)', async () => {
    await mount(vi.fn(), true, false);
    const link = container.querySelector('[data-testid="chat-v3-event-card-sign"]');
    expect(link?.getAttribute('href')).toBe('/gates/g1');
  });

  it('⭐BE가 지은 문구(content)를 그대로 보여준다(제목 발명 0)', async () => {
    await mount();
    expect(container.textContent).toContain('발행 승인을 올려요');
  });

  it('⭐변경 요청 — 다이얼로그에서 사유 입력 후 제출하면 POST /transition {status:rejected}', async () => {
    const onDone = await mount();
    const btn = container.querySelector('[data-testid="chat-v3-event-card-request-changes"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    const textarea = document.body.querySelector('[data-testid="chat-v3-reason-textarea"]') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(textarea, '근거가 부족해요');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const submit = document.body.querySelector('[data-testid="chat-v3-reason-submit"]') as HTMLButtonElement;
    await act(async () => { submit.click(); });
    await act(async () => { await Promise.resolve(); });
    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/gates/g1/transition');
    expect(call).toBeDefined();
    expect(JSON.parse(call![1].body as string)).toEqual({ status: 'rejected', note: '근거가 부족해요', evidence_viewed: false, reviewed_head_sha: null });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  // 페드루 PO CHANGES C3(2026-09-17 00:04Z, PR #4370) — gate_already_resolved는
  // 실패 문구가 아니라 재조회로 흡수한다(#3964/#3970과 같은 결).
  it('⭐변경 요청 — gate_already_resolved면 오류문장 대신 재조회(onDone)만 호출된다', async () => {
    fetchMock.mockResolvedValue({
      ok: false, status: 409, json: async () => ({ error: { code: 'gate_already_resolved' } }),
    });
    const onDone = await mount();
    const btn = container.querySelector('[data-testid="chat-v3-event-card-request-changes"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    const textarea = document.body.querySelector('[data-testid="chat-v3-reason-textarea"]') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(textarea, '근거가 부족해요');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const submit = document.body.querySelector('[data-testid="chat-v3-reason-submit"]') as HTMLButtonElement;
    await act(async () => { submit.click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('[role="alert"]')).toBeNull();
  });
});
