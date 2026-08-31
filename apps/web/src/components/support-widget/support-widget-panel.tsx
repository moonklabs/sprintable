'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Send, X } from 'lucide-react';
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
 * story #3260 — status는 항상 'unavailable'(Support Gateway 계약 착지 전, use-support-widget-
 * session.ts 참고) — 그래도 'connecting'/'ready' 분기를 지금 갖춰두는 이유: 계약 착지 후
 * 훅 내부만 교체되면 이 컴포넌트는 무변경으로 실 데이터를 그대로 그린다(호출부 재작업 0).
 */
export function SupportWidgetPanelBody({ session }: { session: SupportWidgetSession }) {
  const t = useTranslations('supportWidget');
  const [draft, setDraft] = useState('');

  if (session.status === 'unavailable' || session.status === 'error') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-6 text-center">
        <p className="text-sm font-medium text-foreground">{t('unavailableTitle')}</p>
        <p className="text-xs text-muted-foreground">{t('unavailableBody')}</p>
      </div>
    );
  }

  const canSend = draft.trim().length > 0 && session.status === 'ready';

  return (
    <>
      <div className="flex-1 space-y-2 overflow-y-auto px-3 py-3">
        {session.status === 'connecting' ? (
          <div className="h-8 animate-pulse rounded-lg bg-muted" />
        ) : (
          session.messages.map((m) => (
            <div
              key={m.id}
              className={`max-w-[85%] rounded-xl px-3 py-2 text-sm leading-relaxed [overflow-wrap:anywhere] ${
                m.role === 'user' ? 'ml-auto bg-proof-blue-soft text-foreground' : 'bg-muted text-foreground'
              }`}
            >
              {m.content}
            </div>
          ))
        )}
      </div>
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
          disabled={session.status !== 'ready'}
          className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
        />
        <Button type="submit" size="sm" disabled={!canSend} aria-label={t('sendLabel')}>
          <Send className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </form>
    </>
  );
}
