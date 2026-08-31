// story #3260 Phase 2(2026-08-31) — Support Gateway(support-gateway/, 디디) 계약이 착지했다
// (schemas.py/routers/sessions.py, PR#3648 — MessageResponse.content·GET 이력 둘 다 확定).
// 이 훅이 실 fetch 계층(apps/web/src/lib/support-widget/gateway-client.ts)을 소비한다.
//
// ⚠️본체 chat 실시간(realtime-provider.tsx `useSseMultiplexerContext()`)은 절대 구독하지
// 않는다 — Gateway는 SSE/스트리밍이 아예 없다(동기 왕복 단일 계약, schemas.py
// MessageExchangeResponse 문서 참고 — "v1: 동기 왕복"). 이중소비·고아 슬롯 결함 클래스가
// 애초에 재발할 표면 자체가 없다(story #2102급 원칙을 셸 설계 단계에서 이미 충족).
'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  createOrResumeGatewaySession,
  isSupportGatewayConfigured,
  listGatewayMessages,
  sendGatewayMessage,
  type GatewayMessage,
} from '@/lib/support-widget/gateway-client';

// story #3260 2차(페드루 PO) — unavailable은 «Gateway 미도달(이 빌드에 아예 안 붙어있음)»
// 딱 하나로 좁힌다. 붙어있는데 연결이 실패한 경우('error')와 뜻이 다르다 — 전자는 재시도
// 자체가 무의미(설정이 없다)하고 후자는 connect() 재시도가 의미 있다(패널이 이 구분으로
// 다른 UI를 그린다).
export type SupportWidgetStatus = 'unavailable' | 'connecting' | 'ready' | 'error';

export interface SupportWidgetMessage {
  id: string;
  role: 'user' | 'agent';
  content: string;
  createdAt: string;
  /** agent 메시지 전용 — Gateway가 사람에게 연결했다는 뜻(무신호 아님, 항상 진짜 안내
   * 텍스트를 동반 — support-gateway/app/no_fiction_guard.py가 지어낸 서술을 구조적으로
   * 차단하므로 이 플래그가 true여도 content는 항상 정직한 문구다). */
  escalated?: boolean;
  /** 낙관적 echo(서버 확認 전) — 실패하지 않았다면 응답 도착 즉시 실 메시지로 교체된다. */
  pending?: boolean;
  /** 왕복 자체가 실패(네트워크·5xx)해 서버가 이 메시지를 못 받았을 수 있는 상태 —
   * "성공한 척" 지우지 않고 실패를 그대로 보여준다(no-fiction). */
  failed?: boolean;
}

export interface SupportWidgetSession {
  status: SupportWidgetStatus;
  messages: SupportWidgetMessage[];
  /** POST /messages 왕복이 진행 중 — story #3261 실측(~12초)이라 패널이 이 값으로
   * "생각 중" 지속 신호(경과 초 등)를 그린다(무신호 금지, 페드루 지시). */
  sending: boolean;
  /** 가장 최근 실패의 사람 문구 — «사람 연결» 폴백 안내(카디르 지적 승계, 필수 요건). */
  sendError: string | null;
  /** 위젯이 열릴 때만 호출(lazy). status가 'connecting'|'ready'면 재호출은 no-op —
   * 'error'에서는 재시도로 동작한다(사용자가 다시 열거나 재시도 트리거 시). */
  connect: () => void;
  sendMessage: (content: string) => Promise<void>;
  /** sendError가 있을 때만 의미 있음 — 실패한 마지막 메시지를 같은 내용으로 재전송. */
  retryLastMessage: () => void;
}

function toWidgetMessage(m: GatewayMessage): SupportWidgetMessage {
  return {
    id: m.id,
    role: m.role === 'customer' ? 'user' : 'agent',
    content: m.content,
    createdAt: m.created_at,
  };
}

export function useSupportWidgetSession(): SupportWidgetSession {
  // story #3260 2차(유나 design 판정, 2026-08-31) — 이 문구가 하드코딩 한글이라 i18n
  // leak이었다(en 빌드에서도 한글이 그대로 뜨는 결함). 훅이 next-intl useTranslations()를
  // 직접 불러 'chats'류 다른 훅과 동일하게 t()로 렌더한다(패널이 아니라 훅이 소유 —
  // sendError는 이미 "완성된 표시용 문구" 계약이라 패널에 원인 코드를 별도로 안 넘긴다).
  const t = useTranslations('supportWidget');
  const [status, setStatus] = useState<SupportWidgetStatus>('unavailable');
  const [messages, setMessages] = useState<SupportWidgetMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const connectingRef = useRef(false);
  const lastFailedContentRef = useRef<string | null>(null);
  // story #3260 2차 finding(유나 라이브 실측 FAIL — 재시도 스톰, 2026-08-31) — 호출부
  // (support-widget-launcher.tsx)의 effect deps 축소가 1차 방어. 이건 2차 방어(백오프) —
  // connect()를 부르는 다른 경로가 미래에 또 생겨도, 최근 시도로부터 이 시간 안이면
  // 무조건 no-op(네트워크를 새로 안 태움). CSP 차단처럼 즉시 실패하는 케이스는 재시도
  // 간격이 사실상 0이 될 수 있어(왕복 지연 없음) 이 가드가 없으면 순수 동기 루프가 된다.
  const lastAttemptAtRef = useRef(0);
  const MIN_RETRY_INTERVAL_MS = 1000;

  const connect = useCallback(() => {
    // Gateway 자체가 이 빌드에 안 붙어있음 — 정직한 'unavailable' 유지, 재시도할 대상이 없다.
    if (!isSupportGatewayConfigured()) return;
    if (connectingRef.current || status === 'ready') return;
    const now = Date.now();
    if (now - lastAttemptAtRef.current < MIN_RETRY_INTERVAL_MS) return;
    lastAttemptAtRef.current = now;
    connectingRef.current = true;
    setStatus('connecting');
    setSendError(null);
    void (async () => {
      try {
        const session = await createOrResumeGatewaySession();
        sessionIdRef.current = session.id;
        const history = await listGatewayMessages(session.id);
        setMessages(history.map(toWidgetMessage));
        setStatus('ready');
      } catch {
        setStatus('error');
      } finally {
        connectingRef.current = false;
      }
    })();
  }, [status]);

  const sendMessage = useCallback(async (content: string) => {
    const sessionId = sessionIdRef.current;
    if (!sessionId || sending) return;
    const optimisticId = `local-${Date.now()}`;
    // 낙관적 echo — 실제로 입력한 내용을 그대로 보여줄 뿐(지어낸 응답 아님), ~12초 왕복
    // 동안 "내가 보낸 게 맞나" 불안을 없앤다. pending 플래그로 서버 확認 전임을 구분.
    setMessages((prev) => [
      ...prev,
      { id: optimisticId, role: 'user', content, createdAt: new Date().toISOString(), pending: true },
    ]);
    setSending(true);
    setSendError(null);
    lastFailedContentRef.current = null;
    try {
      const exchange = await sendGatewayMessage(sessionId, content);
      setMessages((prev) => [
        ...prev.filter((m) => m.id !== optimisticId),
        toWidgetMessage(exchange.customer_message),
        { ...toWidgetMessage(exchange.agent_message), escalated: exchange.escalated },
      ]);
    } catch {
      lastFailedContentRef.current = content;
      setMessages((prev) => prev.map((m) => (m.id === optimisticId ? { ...m, pending: false, failed: true } : m)));
      // 카디르 지적 승계(필수) — 500/무신호 금지. 서버가 무슨 이유로 죽었든(타임아웃·5xx)
      // 위젯은 항상 이 정직한 «사람 연결» 폴백 문구를 보여준다.
      setSendError(t('sendErrorFallback'));
    } finally {
      setSending(false);
    }
  }, [sending, t]);

  const retryLastMessage = useCallback(() => {
    const content = lastFailedContentRef.current;
    if (!content) return;
    setMessages((prev) => prev.filter((m) => !(m.failed && m.content === content)));
    void sendMessage(content);
  }, [sendMessage]);

  // 반환 객체 자체를 안정화 — 호출부(support-widget-launcher.tsx)가 이 객체를 effect
  // deps에 그대로 넣는다(값이 안 바뀌면 재렌더가 connect()를 불필요하게 재호출하지 않게).
  return useMemo(
    () => ({ status, messages, sending, sendError, connect, sendMessage, retryLastMessage }),
    [status, messages, sending, sendError, connect, sendMessage, retryLastMessage],
  );
}
