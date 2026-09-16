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

async function mount(onDone = vi.fn()) {
  await act(async () => {
    root.render(wrap(<ChatV3EventCard approvalTarget={approvalTarget} content="발행 승인을 올려요" onDone={onDone} />));
  });
  return onDone;
}

describe('ChatV3EventCard', () => {
  it('⭐서명은 /gates/{id} 링크(인라인 승인 0 — 「오늘」에서만)', async () => {
    await mount();
    const link = container.querySelector('a[href="/gates/g1"]');
    expect(link).not.toBeNull();
    expect(link?.textContent).toBe('「오늘」에서 서명');
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
});
