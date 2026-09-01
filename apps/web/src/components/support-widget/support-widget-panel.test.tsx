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
    escalationStatus: null,
    conversationId: 'conv-1',
    isEnded: false,
    conversations: null,
    sending: false,
    sendError: null,
    connect: vi.fn(),
    sendMessage: vi.fn(async () => {}),
    retryLastMessage: vi.fn(),
    startNewConversation: vi.fn(async () => {}),
    endConversation: vi.fn(async () => {}),
    selectConversation: vi.fn(async () => {}),
    viewActiveConversation: vi.fn(async () => {}),
    loadConversations: vi.fn(async () => {}),
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

  it('escalated 메시지는 "담당자에게 전달됨" 배지를 함께 보인다', async () => {
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

  it('story #3263 AC4 — escalationStatus가 open이면 지속 배너가 뜬다(턴이 지나간 뒤·재오픈 후에도, 무신호 금지)', async () => {
    await mount(baseSession({ escalationStatus: 'open', messages: [] }));
    expect(container.textContent).toContain(koMessages.supportWidget.escalationOpenBanner);
  });

  it('story #3263 AC4 — escalationStatus가 null/resolved면 지속 배너를 안 띄운다(평시엔 무의미한 배너로 화면을 어지럽히지 않는다)', async () => {
    await mount(baseSession({ escalationStatus: null }));
    expect(container.textContent).not.toContain(koMessages.supportWidget.escalationOpenBanner);
    await mount(baseSession({ escalationStatus: 'resolved' }));
    expect(container.textContent).not.toContain(koMessages.supportWidget.escalationOpenBanner);
  });

  it('failed 메시지는 실패 마커를 보이고 조용히 사라지지 않는다(no-fiction)', async () => {
    await mount(baseSession({
      messages: [{ id: 'local-1', role: 'user', content: '안 보내진 메시지', createdAt: 't', failed: true }],
    }));
    expect(container.textContent).toContain('안 보내진 메시지');
    expect(container.textContent).toContain(koMessages.supportWidget.messageFailedLabel);
  });

  describe('story #3276 — 상담 수명주기(새 상담·종료·목록)', () => {
    it('isEnded=true면 종료 배너가 뜨고 입력창이 비활성화된다(읽기 전용 이력)', async () => {
      await mount(baseSession({ isEnded: true, messages: [{ id: 'm1', role: 'agent', content: '지난 답변', createdAt: 't' }] }));
      expect(container.textContent).toContain(koMessages.supportWidget.conversationEndedBanner);
      const input = container.querySelector('input') as HTMLInputElement;
      expect(input.disabled).toBe(true);
    });

    it('isEnded=false면 종료 배너가 없고 입력창이 활성 상태다', async () => {
      await mount(baseSession({ isEnded: false }));
      expect(container.textContent).not.toContain(koMessages.supportWidget.conversationEndedBanner);
      const input = container.querySelector('input') as HTMLInputElement;
      expect(input.disabled).toBe(false);
    });

    it('"새 상담" 버튼 클릭 시 startNewConversation()을 부른다', async () => {
      const startNewConversation = vi.fn(async () => {});
      await mount(baseSession({ startNewConversation }));
      const btn = Array.from(container.querySelectorAll('button')).find(
        (b) => b.textContent === koMessages.supportWidget.startNewConversation,
      )!;
      await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      expect(startNewConversation).toHaveBeenCalledTimes(1);
    });

    it('종료 배너의 "새 상담 시작" 버튼도 startNewConversation()을 부른다', async () => {
      const startNewConversation = vi.fn(async () => {});
      await mount(baseSession({ isEnded: true, startNewConversation }));
      const buttons = Array.from(container.querySelectorAll('button')).filter(
        (b) => b.textContent === koMessages.supportWidget.startNewConversation,
      );
      expect(buttons.length).toBeGreaterThanOrEqual(2); // 툴바 1개 + 배너 1개.
      await act(async () => { buttons[buttons.length - 1]!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      expect(startNewConversation).toHaveBeenCalledTimes(1);
    });

    it('"상담 종료" 버튼 클릭 시 endConversation()을 부른다(진행 중 상담에서만 뜬다)', async () => {
      const endConversation = vi.fn(async () => {});
      await mount(baseSession({ isEnded: false, conversationId: 'conv-1', endConversation }));
      const btn = Array.from(container.querySelectorAll('button')).find(
        (b) => b.textContent === koMessages.supportWidget.endConversation,
      )!;
      await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      expect(endConversation).toHaveBeenCalledTimes(1);
    });

    it('종료된 상담을 보는 중엔 "상담 종료" 버튼이 안 뜬다(이미 종료됐으니 재종료 액션 무의미)', async () => {
      await mount(baseSession({ isEnded: true }));
      const btn = Array.from(container.querySelectorAll('button')).find(
        (b) => b.textContent === koMessages.supportWidget.endConversation,
      );
      expect(btn).toBeUndefined();
    });
  });

  describe('story #3279 — 운영자 회신 발신자 구분 렌더', () => {
    it('role="operator" 메시지는 "상담원" 라벨을 보인다', async () => {
      await mount(baseSession({
        messages: [{ id: 'op1', role: 'operator', content: '확인했습니다, 답변드릴게요.', createdAt: 't' }],
      }));
      expect(container.textContent).toContain(koMessages.supportWidget.operatorSenderLabel);
      expect(container.textContent).toContain('확인했습니다, 답변드릴게요.');
    });

    it('role="agent"(AI 자동응대) 메시지는 "상담원" 라벨을 안 보인다(발신자 축이 다르다는 것을 실측)', async () => {
      await mount(baseSession({
        messages: [{ id: 'ag1', role: 'agent', content: 'AI 자동 응답입니다.', createdAt: 't' }],
      }));
      expect(container.textContent).not.toContain(koMessages.supportWidget.operatorSenderLabel);
    });

    it('한 대화 안에 operator·agent 메시지가 섞여도 각자 정확히 자기 라벨만 보인다', async () => {
      await mount(baseSession({
        messages: [
          { id: 'ag1', role: 'agent', content: 'AI가 먼저 응대', createdAt: 't1' },
          { id: 'op1', role: 'operator', content: '운영자가 이어서 답변', createdAt: 't2' },
        ],
      }));
      const opBubble = container.querySelector('[data-role="operator"]');
      const agBubble = container.querySelector('[data-role="agent"]');
      expect(opBubble?.textContent).toContain(koMessages.supportWidget.operatorSenderLabel);
      expect(opBubble?.textContent).toContain('운영자가 이어서 답변');
      expect(agBubble?.textContent).not.toContain(koMessages.supportWidget.operatorSenderLabel);
      expect(agBubble?.textContent).toContain('AI가 먼저 응대');
    });
  });
});
