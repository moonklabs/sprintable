'use client';

import { WifiOff, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';

/**
 * story #2987 AC2 후반 — 자동 재연결(§1)이 대부분 소리 없이 복구하지만, 실패하면
 * (예: 서버가 실제로 죽음) 주소창 없는 앱에선 새로고침 우회조차 없다 — 수동 갱신
 * affordance가 유일한 탈출구. 빨강(destructive) 아님 — "네가 실패했다"가 아니라
 * "연결이 끊긴 상태"(reference-drop-notice.tsx와 동일 warning-tint 관례).
 *
 * story #3621 — chat-view.tsx·chat-list-view.tsx 둘 다 같은 배너가 필요해졌다(끊김
 * 표시를 대화 목록 뷰에도, AC3). 유나 CHANGES(2026-09-07) — 복사로 두 곳에 각자
 * 두면 문구가 갈라질 위험이 있어 한 컴포넌트로 단일화한다. `polling`이 켜지면(threshold
 * 10s 이상 지속) 문구가 "자동 새로고침 중"으로 바뀐다 — 배너가 뜨는 2s와 폴링이 켜지는
 * 10s 사이 8초 동안도 수동 새로고침 버튼은 항상 함께 그린다(조치 수단 0인 구간 제거).
 */
export interface ConnectionLostBannerProps {
  polling: boolean;
  onRefresh: () => void;
}

export function ConnectionLostBanner({ polling, onRefresh }: ConnectionLostBannerProps) {
  const t = useTranslations('chats');
  return (
    <div
      data-testid="connection-lost-banner"
      className="flex flex-shrink-0 items-center gap-2 border-b border-warning-border bg-warning-tint px-3 py-2 text-xs text-foreground"
    >
      <WifiOff className="h-3.5 w-3.5 flex-shrink-0" />
      <span className="flex-1" data-testid="connection-lost-banner-text">
        {polling ? t('connectionLostPolling') : t('connectionLost')}
      </span>
      <button
        type="button"
        onClick={onRefresh}
        className="flex items-center gap-1 rounded px-1.5 py-1 font-medium hover:bg-warning-border/40"
      >
        <RefreshCw className="h-3 w-3" />
        {t('refreshNow')}
      </button>
    </div>
  );
}
