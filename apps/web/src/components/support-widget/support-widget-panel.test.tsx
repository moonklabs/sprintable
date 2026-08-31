// @vitest-environment jsdom
//
// story #3260 Phase 2 — 패널 body의 status별 렌더(error 재시도·sending 지속신호·escalated
// 배지·sendError 폴백+재시도)를 useSupportWidgetSession을 직접 모킹해 검증한다(네트워크
// 계약 자체는 use-support-widget-session.test.tsx가 이미 커버).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { SupportWidgetPanelBody } from './support-widget-panel';
import type { SupportWidgetSession } from '@/hooks/use-support-widget-session';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
});

function baseSession(overrides: Partial<SupportWidgetSession> = {}): SupportWidgetSession {
  return {
    status: 'ready',
    messages: [],
    sending: false,
    sendError: null,
    connect: vi.fn(),
    sendMessage: vi.fn(async () => {}),
    retryLastMessage: vi.fn(),
    ...overrides,
  };
}

async function mount(session: SupportWidgetSession) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <SupportWidgetPanelBody session={session} />
      </NextIntlClientProvider>,
    );
  });
}

describe('SupportWidgetPanelBody — story #3260 Phase 2', () => {
  it('error 상태 — unavailable과 다른 문구+재시도 버튼을 보이고, 클릭하면 connect()를 다시 부른다', async () => {
    const connect = vi.fn();
    await mount(baseSession({ status: 'error', connect }));
    expect(container.textContent).toContain(koMessages.supportWidget.errorTitle);
    expect(container.textContent).not.toContain(koMessages.supportWidget.unavailableTitle);
    const retryBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === koMessages.supportWidget.retryConnect)!;
    await act(async () => { retryBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('sending 중엔 "생각 중" 지속 신호가 뜨고, 입력창·전송버튼이 막힌다(무신호 금지)', async () => {
    await mount(baseSession({ sending: true }));
    expect(container.textContent).toContain('생각 중');
    const input = container.querySelector('input') as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });

  it('escalated 메시지는 "담당자에게 연결됨" 배지를 함께 보인다', async () => {
    await mount(baseSession({
      messages: [{ id: 'a1', role: 'agent', content: '담당자를 연결해 드릴게요.', createdAt: 't', escalated: true }],
    }));
    expect(container.textContent).toContain(koMessages.supportWidget.escalatedBadge);
  });

  it('sendError가 있으면 폴백 배너+재시도 버튼이 뜨고, 클릭하면 retryLastMessage()를 부른다(카디르 지적 승계 — 무신호 금지 필수요건)', async () => {
    const retryLastMessage = vi.fn();
    await mount(baseSession({
      sendError: '지금 응답을 받지 못했습니다. 잠시 후 다시 시도하시거나, 담당자에게 직접 문의해 주세요.',
      retryLastMessage,
    }));
    expect(container.textContent).toContain('담당자에게 직접 문의');
    const retryBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === koMessages.supportWidget.sendErrorRetry)!;
    await act(async () => { retryBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(retryLastMessage).toHaveBeenCalledTimes(1);
  });

  it('failed 메시지는 실패 마커를 보이고 조용히 사라지지 않는다(no-fiction)', async () => {
    await mount(baseSession({
      messages: [{ id: 'local-1', role: 'user', content: '안 보내진 메시지', createdAt: 't', failed: true }],
    }));
    expect(container.textContent).toContain('안 보내진 메시지');
    expect(container.textContent).toContain(koMessages.supportWidget.messageFailedLabel);
  });
});
