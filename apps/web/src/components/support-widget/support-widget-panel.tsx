'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Headset, Send, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { SupportWidgetSession } from '@/hooks/use-support-widget-session';

/**
 * story #3260 — 헤더가 반전 톤(bg-foreground/text-background, tooltip.tsx·avatar.tsx와 동일
 * 고대비 페어링 재사용)인 이유: 「자기 org 안 대화가 아니라 Sprintable에 말하는 별도 창」임을
 * 픽셀에서 드러내라는 선생님 지시(Blueprint v0.3) — 이 앱의 일반 헤더(연한 배경)와 시각적으로
 * 확실히 갈라 넣는다.
 */
export function SupportWidgetPanelHeader({ onClose }: { onClose: () => void }) {
  const t = useTranslations('supportWidget');
  return (
    <div className="flex shrink-0 items-start justify-between gap-2 bg-foreground px-4 py-3 text-background">
      <div className="min-w-0">
        <p className="text-sm font-semibold leading-tight">{t('panelTitle')}</p>
        <p className="mt-0.5 text-[11px] leading-snug text-background/70">{t('panelSubtitle')}</p>
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label={t('closeLabel')}
        className="shrink-0 rounded-md p-1 text-background/70 hover:bg-background/10 hover:text-background"
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}

/**
 * story #3260 Phase 2(2026-08-31, 페드루 PO 실 왕복 실측 지적) — support-gateway의
 * Interaction/Execution 루프는 동기 처리라 ~12초까지 걸린다(story #3261). 정적 스피너는
 * "멈춘 건지 도는 건지" 구분이 안 돼 무신호와 다를 바 없다 — 경과 초를 1초마다 갱신해
 * 살아있다는 신호를 지속적으로 준다.
 */
function ThinkingIndicator() {
  const t = useTranslations('supportWidget');
  // 이 컴포넌트는 sending===true인 동안만 마운트되므로(호출부의 조건부 렌더) 매 등장이
  // 곧 새 왕복의 시작 — 0에서 다시 세는 것이 초기 useState(0)만으로 이미 정확하다.
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="flex items-center gap-1.5 rounded-xl bg-muted px-3 py-2 text-sm text-muted-foreground">
      <span className="flex gap-0.5" aria-hidden>
        <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:-0.3s]" />
        <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:-0.15s]" />
        <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60" />
      </span>
      {t('thinkingLabel', { seconds })}
    </div>
  );
}

/**
 * story #3260 Phase 2 — status 4종을 각각 다른 화면으로 그린다:
 * - 'unavailable': Gateway가 이 빌드에 아예 안 붙어있음(재시도 대상 없음, 정직한 "준비 중").
 * - 'error': 붙어있는데 연결 자체가 실패(재시도 버튼 — connect() 재호출로 의미 있음).
 * - 'connecting': 세션+이력 로딩 중.
 * - 'ready': 실 대화. sending 중엔 ThinkingIndicator, sendError면 «사람 연결» 폴백 배너
 *   (카디르 지적 승계 — 500/무신호 금지 필수 요건).
 */
export function SupportWidgetPanelBody({ session }: { session: SupportWidgetSession }) {
  const t = useTranslations('supportWidget');
  const [draft, setDraft] = useState('');

  if (session.status === 'unavailable') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-6 text-center">
        <p className="text-sm font-medium text-foreground">{t('unavailableTitle')}</p>
        <p className="text-xs text-muted-foreground">{t('unavailableBody')}</p>
      </div>
    );
  }

  if (session.status === 'error') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-sm font-medium text-foreground">{t('errorTitle')}</p>
        <p className="text-xs text-muted-foreground">{t('errorBody')}</p>
        <Button type="button" size="sm" variant="secondary" onClick={() => session.connect()}>
          {t('retryConnect')}
        </Button>
      </div>
    );
  }

  const canSend = draft.trim().length > 0 && session.status === 'ready' && !session.sending;

  return (
    <>
      {session.escalationStatus === 'open' ? (
        <div
          role="status"
          className="flex shrink-0 items-center gap-2 border-b border-border bg-muted px-3 py-2 text-xs text-foreground"
        >
          <Headset className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
          {t('escalationOpenBanner')}
        </div>
      ) : null}
      <div className="flex-1 space-y-2 overflow-y-auto px-3 py-3">
        {session.status === 'connecting' ? (
          <div className="h-8 animate-pulse rounded-lg bg-muted" />
        ) : (
          session.messages.map((m) => (
            <div
              key={m.id}
              className={`max-w-[85%] rounded-xl px-3 py-2 text-sm leading-relaxed [overflow-wrap:anywhere] ${
                m.role === 'user' ? 'ml-auto bg-proof-blue-soft text-foreground' : 'bg-muted text-foreground'
              } ${m.pending ? 'opacity-60' : ''} ${m.failed ? 'border border-destructive/50' : ''}`}
            >
              {m.content}
              {m.escalated ? (
                <p className="mt-1 text-[10px] font-medium text-muted-foreground">{t('escalatedBadge')}</p>
              ) : null}
              {m.failed ? (
                <p role="alert" className="mt-1 text-[10px] font-medium text-destructive">{t('messageFailedLabel')}</p>
              ) : null}
            </div>
          ))
        )}
        {session.sending ? <ThinkingIndicator /> : null}
      </div>
      {session.sendError ? (
        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border bg-destructive/10 px-3 py-2">
          <p role="alert" aria-live="assertive" className="text-xs text-foreground">{session.sendError}</p>
          <Button type="button" size="sm" variant="outline" onClick={() => session.retryLastMessage()}>
            {t('sendErrorRetry')}
          </Button>
        </div>
      ) : null}
      <form
        className="flex shrink-0 items-center gap-1.5 border-t border-border p-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!canSend) return;
          void session.sendMessage(draft.trim());
          setDraft('');
        }}
      >
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t('inputPlaceholder')}
          disabled={session.status !== 'ready' || session.sending}
          className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
        />
        <Button type="submit" size="sm" disabled={!canSend} aria-label={t('sendLabel')}>
          <Send className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </form>
    </>
  );
}
