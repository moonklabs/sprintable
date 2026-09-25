'use client';

import { useLayoutEffect, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useTopBar } from '@/components/nav/top-bar-context';

/**
 * story #4326 — «전체» · «결재» · «대화»로 옮기는 사이(옛 화면 언마운트 → 도착 화면 마운트 전 · loading.tsx가 뜬 동안) 상단바 제목 · 칩이
 * 0.3~1.4초 비었다(402 · 배포 30 곁 측정). 4291 AC3가 일감 탭에서 막은 부류의 남은 자리 — 같은 방식: 도착 화면이 쓰는 제목을 **폴백**으로 쥔다
 * (top-bar-context `setFallback` · 화면 슬롯이 붙으면 늘 그쪽이 이긴다). 제목 모양은 화면과 폴백이 **같은 컴포넌트**를 써서 갈리지 않는다.
 */

/** «전체»(/more) 상단바 제목 — 화면(more/page)과 폴백(more/loading)이 같이 쓴다. */
export function MoreTopBarTitle() {
  const t = useTranslations('nav');
  return <h1 className="text-sm font-medium">{t('moreMenuTitle')}</h1>;
}

/** «대화»(/chats) 상단바 제목 — 화면(chats/page)과 폴백(chats/loading)이 같이 쓴다. */
export function ChatsTopBarTitle() {
  const t = useTranslations('chats');
  return <p className="text-sm font-medium">{t('title')}</p>;
}

export type InboxTabKey = 'attention' | 'notifications' | 'gates';

/** 결재 탭 이름 표 — 화면의 탭 줄 · 상단바 제목 · 폴백이 한 곳에서 읽는다(story #2164: 헤더는 늘 지금 탭의 진짜 이름). */
export function useInboxTabLabels(): ReadonlyArray<{ key: InboxTabKey; label: string }> {
  const t = useTranslations('inbox');
  const tCage = useTranslations('cage');
  return [
    { key: 'attention', label: t('attentionTabLabel') },
    { key: 'notifications', label: t('notificationsTabLabel') },
    { key: 'gates', label: tCage('gateTabLabel') },
  ];
}

/** «결재»(/inbox) 상단바 제목 — 알림 탭이면 안 읽은 수(모르면 0 → 안 붙임 · story #4281). 화면과 폴백이 같이 쓴다. */
export function InboxTopBarTitle({ tab, unreadCount = 0 }: { tab: string; unreadCount?: number }) {
  const labels = useInboxTabLabels();
  const label = labels.find((l) => l.key === tab)?.label ?? labels.find((l) => l.key === 'notifications')!.label;
  return (
    <div className="flex items-center gap-2">
      <h1 className="text-sm font-medium">{label}</h1>
      {/* story #4281 — 이 숫자는 알림 탭의 안 읽은 수다. 오늘 · 결재함 탭엔 그 탭의 수를 모르므로 안 붙인다. */}
      {tab === 'notifications' && unreadCount > 0 ? (
        <span className="text-sm tabular-nums text-muted-foreground">{unreadCount}</span>
      ) : null}
    </div>
  );
}

/**
 * 폴백을 쥐는 조각 — loading.tsx에 둔다(도착 화면이 붙기 전 구간에만 산다). 칠해지기 전에 쥐도록 layout effect(한 프레임이라도 빈 상단바를
 * 칠하지 않게) · 떠날 때 비운다(화면 슬롯이 이미 붙어 있으니 비워도 안 보인다).
 */
export function TopBarFallbackHolder({ title, showContextChip }: { title: ReactNode; showContextChip: boolean }) {
  const { setFallback } = useTopBar();
  useLayoutEffect(() => {
    setFallback({ title, showContextChip });
    return () => setFallback(null);
    // title은 경로 · 로케일에서만 파생 — 매 렌더 새 엘리먼트라 deps에 넣지 않는다(4291 WorkTabTitleFallback과 같은 이유).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setFallback, showContextChip]);
  return null;
}

/** 결재 loading 전용 — 도착 탭(?tab=)의 이름을 제목으로(수는 아직 모름 → 안 붙임). */
export function InboxTopBarFallback() {
  const tab = useSearchParams().get('tab') ?? 'notifications';
  // key로 탭이 바뀌면 다시 쥔다(holder effect는 제목 엘리먼트를 deps에 안 넣는다).
  return <TopBarFallbackHolder key={tab} title={<InboxTopBarTitle tab={tab} />} showContextChip />;
}
