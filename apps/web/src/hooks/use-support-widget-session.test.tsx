// @vitest-environment jsdom
//
// story #3260 Phase 2(2026-08-31) — Support Gateway 계약(디디 PR#3648)이 착지한 뒤 이 훅이
// 실 fetch 계층(gateway-client.ts)을 올바르게 소비하는지 검증한다. 훅 자체는 @testing-
// library/react-hooks 없이(use-render-nonce.test.tsx 등 이 레포 관례) 작은 하니스
// 컴포넌트로 마운트해 DOM 텍스트/속성으로 상태를 읽는다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../messages/ko.json';
import enMessages from '../../messages/en.json';
import { useSupportWidgetSession } from './use-support-widget-session';

const isSupportGatewayConfiguredMock = vi.fn();
const createOrResumeGatewaySessionMock = vi.fn();
const listGatewayMessagesMock = vi.fn();
const sendGatewayMessageMock = vi.fn();

vi.mock('@/lib/support-widget/gateway-client', () => ({
  isSupportGatewayConfigured: () => isSupportGatewayConfiguredMock(),
  createOrResumeGatewaySession: (...args: unknown[]) => createOrResumeGatewaySessionMock(...args),
  listGatewayMessages: (...args: unknown[]) => listGatewayMessagesMock(...args),
  sendGatewayMessage: (...args: unknown[]) => sendGatewayMessageMock(...args),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  isSupportGatewayConfiguredMock.mockReset().mockReturnValue(true);
  createOrResumeGatewaySessionMock.mockReset();
  listGatewayMessagesMock.mockReset();
  sendGatewayMessageMock.mockReset();
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

function Harness() {
  const session = useSupportWidgetSession();
  return (
    <div>
      <span data-testid="status">{session.status}</span>
      <span data-testid="sending">{String(session.sending)}</span>
      <span data-testid="send-error">{session.sendError ?? ''}</span>
      <ul>
        {session.messages.map((m) => (
          <li key={m.id} data-role={m.role} data-pending={m.pending} data-failed={m.failed} data-escalated={m.escalated}>
            {m.content}
          </li>
        ))}
      </ul>
      <button type="button" onClick={() => session.connect()}>connect</button>
      <button type="button" onClick={() => void session.sendMessage('안녕하세요')}>send</button>
      <button type="button" onClick={() => session.retryLastMessage()}>retry</button>
    </div>
  );
}

async function mount(locale: 'ko' | 'en' = 'ko') {
  const messages = locale === 'ko' ? koMessages : enMessages;
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={messages} timeZone="Asia/Seoul">
        <Harness />
      </NextIntlClientProvider>,
    );
  });
}

function statusText() { return container.querySelector('[data-testid="status"]')!.textContent; }
function click(label: string) {
  const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label)!;
  return act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

describe('useSupportWidgetSession — story #3260 Phase 2', () => {
  it('Gateway가 이 빌드에 안 붙어있으면(isSupportGatewayConfigured=false) connect()해도 unavailable 그대로다', async () => {
    isSupportGatewayConfiguredMock.mockReturnValue(false);
    await mount();
    await click('connect');
    expect(statusText()).toBe('unavailable');
    expect(createOrResumeGatewaySessionMock).not.toHaveBeenCalled();
  });

  it('connect() 성공 — 세션 생성+이력 조회 후 ready로 전환되고 이력이 그대로 렌더된다', async () => {
    createOrResumeGatewaySessionMock.mockResolvedValue({ id: 'sess-1', org_id: 'org-1', created_at: 'now' });
    listGatewayMessagesMock.mockResolvedValue([
      { id: 'm1', conversation_id: 'c1', role: 'customer', content: '이전 문의', created_at: 't1' },
      { id: 'm2', conversation_id: 'c1', role: 'agent', content: '이전 응답', created_at: 't2' },
    ]);
    await mount();
    await click('connect');
    expect(statusText()).toBe('ready');
    expect(container.textContent).toContain('이전 문의');
    expect(container.textContent).toContain('이전 응답');
  });

  it('connect() 실패 — error 상태로 전환된다(unavailable과 구분)', async () => {
    createOrResumeGatewaySessionMock.mockRejectedValue(new Error('network down'));
    await mount();
    await click('connect');
    expect(statusText()).toBe('error');
  });

  it('sendMessage 성공 — 낙관적 echo가 실 메시지(+escalated 플래그)로 교체된다', async () => {
    createOrResumeGatewaySessionMock.mockResolvedValue({ id: 'sess-1', org_id: 'org-1', created_at: 'now' });
    listGatewayMessagesMock.mockResolvedValue([]);
    sendGatewayMessageMock.mockResolvedValue({
      customer_message: { id: 'c1', conversation_id: 'conv-1', role: 'customer', content: '안녕하세요', created_at: 't1' },
      agent_message: { id: 'a1', conversation_id: 'conv-1', role: 'agent', content: '무엇을 도와드릴까요?', created_at: 't2' },
      escalated: false,
    });
    await mount();
    await click('connect');
    await click('send');
    expect(container.textContent).toContain('무엇을 도와드릴까요?');
    expect(container.querySelector('[data-testid="sending"]')!.textContent).toBe('false');
    // 낙관적 local-* id가 실 서버 id로 교체돼 pending 마커가 안 남는다.
    expect(container.querySelector('[data-pending="true"]')).toBeNull();
  });

  it('sendMessage 실패 — 카디르 지적 승계(필수): 500/무신호 대신 sendError 정직 문구+실패 마커가 남는다', async () => {
    createOrResumeGatewaySessionMock.mockResolvedValue({ id: 'sess-1', org_id: 'org-1', created_at: 'now' });
    listGatewayMessagesMock.mockResolvedValue([]);
    sendGatewayMessageMock.mockRejectedValue(new Error('HTTP 500'));
    await mount();
    await click('connect');
    await click('send');
    // story #3260 2차(유나 design 판정) — 하드코딩 한글 문구 leak 회귀가드. i18n 키
    // (supportWidget.sendErrorFallback)로 렌더된 실 값과 정확히 일치해야 한다.
    expect(container.querySelector('[data-testid="send-error"]')!.textContent).toBe(koMessages.supportWidget.sendErrorFallback);
    expect(container.querySelector('[data-failed="true"]')).not.toBeNull();
  });

  it('EN 로케일 크로스체크(카디르 QA 뮤테이션 실증 반영) — ko/en 양쪽이 같은 값을 참조해 동어반복이던 갭을 닫는다. locale=en으로 마운트하면 영문 문구가 뜬다 — 하드코딩 한글로 되돌리는 회귀는 이 테스트에서 반드시 red가 된다(ko 대조 테스트만으론 t() 걷어내도 green이었던 뮤테이션 갭).', async () => {
    createOrResumeGatewaySessionMock.mockResolvedValue({ id: 'sess-1', org_id: 'org-1', created_at: 'now' });
    listGatewayMessagesMock.mockResolvedValue([]);
    sendGatewayMessageMock.mockRejectedValue(new Error('HTTP 500'));
    await mount('en');
    await click('connect');
    await click('send');
    const rendered = container.querySelector('[data-testid="send-error"]')!.textContent;
    expect(rendered).toBe(enMessages.supportWidget.sendErrorFallback);
    expect(rendered).not.toBe(koMessages.supportWidget.sendErrorFallback);
  });

  it('retryLastMessage — 실패한 메시지를 같은 내용으로 재전송하고 성공하면 실패 마커가 지워진다', async () => {
    createOrResumeGatewaySessionMock.mockResolvedValue({ id: 'sess-1', org_id: 'org-1', created_at: 'now' });
    listGatewayMessagesMock.mockResolvedValue([]);
    sendGatewayMessageMock.mockRejectedValueOnce(new Error('HTTP 500'));
    sendGatewayMessageMock.mockResolvedValueOnce({
      customer_message: { id: 'c1', conversation_id: 'conv-1', role: 'customer', content: '안녕하세요', created_at: 't1' },
      agent_message: { id: 'a1', conversation_id: 'conv-1', role: 'agent', content: '재시도 성공', created_at: 't2' },
      escalated: false,
    });
    await mount();
    await click('connect');
    await click('send');
    expect(container.querySelector('[data-failed="true"]')).not.toBeNull();
    await click('retry');
    expect(container.querySelector('[data-failed="true"]')).toBeNull();
    expect(container.textContent).toContain('재시도 성공');
  });
});
