'use client';

import { useLayoutEffect, type ReactNode } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useTopBar } from '@/components/nav/top-bar-context';
import { Badge } from '@/components/ui/badge';

/**
 * story #4326 — «전체» · «결재» · «대화»로 옮기는 사이(옛 화면 언마운트 → 도착 화면 마운트 전 · loading.tsx가 뜬 동안) 상단바 제목 · 칩이
 * 0.3~1.4초 비었다(402 · 배포 30 곁 측정). 4291 AC3가 일감 탭에서 막은 부류의 남은 자리 — 같은 방식: 도착 화면이 쓰는 제목을 **폴백**으로 쥔다
 * (top-bar-context `holdFallback` · 화면 슬롯이 붙으면 늘 그쪽이 이긴다). 제목 모양은 화면과 폴백이 **같은 컴포넌트**를 써서 갈리지 않는다.
 */

/** «전체»(/more) 상단바 제목 — 화면(more/page)과 폴백(more/loading)이 같이 쓴다. */
export function MoreTopBarTitle() {
  const tNav = useTranslations('nav');
  return <h1 className="text-sm font-medium">{tNav('moreMenuTitle')}</h1>;
}

/** «대화»(/chats) 상단바 제목 — 화면(chats/page)과 폴백(chats/loading)이 같이 쓴다. */
export function ChatsTopBarTitle() {
  const tChats = useTranslations('chats');
  return <p className="text-sm font-medium">{tChats('title')}</p>;
}

export type InboxTabKey = 'attention' | 'notifications' | 'gates';

/** 결재 탭 이름 표 — 화면의 탭 줄 · 상단바 제목 · 폴백이 한 곳에서 읽는다(story #2164: 헤더는 늘 지금 탭의 진짜 이름). */
export function useInboxTabLabels(): ReadonlyArray<{ key: InboxTabKey; label: string }> {
  const tInbox = useTranslations('inbox');
  const tCage = useTranslations('cage');
  return [
    { key: 'attention', label: tInbox('attentionTabLabel') },
    { key: 'notifications', label: tInbox('notificationsTabLabel') },
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
  const { holdFallback } = useTopBar();
  useLayoutEffect(() => {
    // 자기가 세운 폴백만 치운다(떠나는 쪽의 늦은 정리가 도착 폴백을 지우지 않게 · top-bar-context holdFallback).
    return holdFallback({ title, showContextChip });
    // title은 경로 · 로케일에서만 파생 — 매 렌더 새 엘리먼트라 deps에 넣지 않는다(4291 WorkTabTitleFallback과 같은 이유).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holdFallback, showContextChip]);
  return null;
}

/** «채널»(/channel) 상단바 제목 — 연결 상태 점은 화면만 안다(폴백은 점 없이). 화면과 폴백이 같이 쓴다. */
export function ChannelTopBarTitle({ statusDot }: { statusDot?: { className: string; label: string } }) {
  const tChannel = useTranslations('channel');
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm font-medium text-foreground">{tChannel('title')}</span>
      {statusDot ? <span className={`h-2 w-2 rounded-full ${statusDot.className}`} title={statusDot.label} /> : null}
    </div>
  );
}

/** «보상»(/rewards) 상단바 제목 — 화면과 폴백이 같이 쓴다. */
export function RewardsTopBarTitle() {
  const tRewards = useTranslations('rewards');
  return <h1 className="text-sm font-medium">{tRewards('title')}</h1>;
}

/** «목표»(`[ws]/[proj]/goals` 목록) 상단바 제목 — 화면(목록 · 로딩 분기)과 폴백이 같이 쓴다. 본문 마스트헤드가 진짜 h1이라 비-헤딩(story #3945). */
export function GoalsTopBarTitle() {
  const tGoals = useTranslations('goals');
  return <p className="text-sm font-medium">{tGoals('title')}</p>;
}

/** «실행»(`[ws]/[proj]/loops` 목록) 상단바 제목 — 화면(목록 · 로딩 분기)과 폴백이 같이 쓴다. */
export function LoopsTopBarTitle() {
  const tLoops = useTranslations('loops');
  return <h1 className="text-sm font-medium">{tLoops('title')}</h1>;
}

/** «문서»(`[ws]/[proj]/docs` 목록) 상단바 제목 — 상단바 크롬이라 비-헤딩(story #3945 · 본문 h1과 겹치지 않게). */
export function DocsTopBarTitle() {
  const tDocs = useTranslations('docs');
  return <p className="text-sm font-medium">{tDocs('title')}</p>;
}

/** «활동 로그»(/activity 첫 탭 = 감사 로그) 상단바 제목. */
export function ActivityTopBarTitle() {
  const tActivityLog = useTranslations('activityLog');
  return <h1 className="text-sm font-medium">{tActivityLog('title')}</h1>;
}

/** «에이전트»(/organization/workforce) 상단바 제목 — 탭과 무관하게 고정(agents-page-tabs). */
export function AgentsTopBarTitle() {
  const tAgents = useTranslations('agents');
  return <h1 className="text-sm font-medium">{tAgents('title')}</h1>;
}

/**
 * «스토리지»(`[ws]/[proj]/storage`) 상단바 제목 — 브레드크럼 · 이름은 고정, «N개 자산 · 용량» 알약은 데이터라 화면만 넘긴다(폴백은 알약 없이 ·
 * PO 규칙: 폴백은 도착 화면과 글자가 똑같은 부분만). 폰은 브레드크럼을 숨기고 알약이 먼저 양보해 말줄임(story #4277).
 */
export function StorageTopBarTitle({ summaryText }: { summaryText?: string }) {
  const tStorage = useTranslations('storage');
  return (
    // grow — 남는 폭을 알약 칸까지 내려보낸다(기준 폭은 안 바뀌어 칩 · 제목 자리 그대로). 없으면 칸이 받을 폭이 0이라 1440에서도 알약이 «…»(실측 18px).
    <div className="flex min-w-0 grow items-center">
      <span className="mr-2.5 hidden shrink-0 text-[12px] text-muted-foreground sm:inline">{tStorage('breadcrumb')}</span>
      <span className="mr-2.5 hidden shrink-0 text-[12px] text-muted-foreground sm:inline">/</span>
      <h1 className="shrink-0 text-[15px] font-[650] tracking-[-0.01em] text-foreground">{tStorage('title')}</h1>
      {/* 유나 4688 — 알약이 붙으며 제목 묶음의 기준 폭이 커져 칩이 자리를 내주고 제목이 62px 왼쪽으로 튀었다(390 · 폴백이 먼저 서며 보이게 됨).
          알약 칸은 너비 0에서 남는 폭만 채운다(`w-0 grow` — 묶음의 기준 폭에 안 섞임) · 알약 자체는 글자 폭 그대로 · 모자라면 말줄임(4672 의도).
          제목과의 간격도 칸 **안**(알약의 왼쪽 여백)에 둔다 — 묶음의 gap · 칸의 margin은 너비 0 칸이어도 기준 폭에 14px를 더해 제목이 그만큼 튀었다(실측).
          폰(sm 미만)에선 알약을 안 그린다(유나 판단 (b)) — 칩이 기준 폭을 지키면 남는 폭이 ~18px라 «…»만 남아 내용이 있는 모양만 보이는 거짓이
          되고, 전체 글자(`title`)는 호버 전용이라 폰에선 닿을 길이 없다. «지금 어디인가»(칩)가 요약 수보다 우선. */}
      {summaryText !== undefined ? (
        <span className="hidden w-0 min-w-0 grow sm:flex" data-testid="storage-summary-slot">
          <Badge variant="info" className="ml-3.5 min-w-0 max-w-[calc(100%-0.875rem)] shrink font-bold" title={summaryText} data-testid="storage-summary-badge">
            <span className="min-w-0 truncate">{summaryText}</span>
          </Badge>
        </span>
      ) : null}
    </div>
  );
}

/** 결재 폴백 제목 — 도착 탭(?tab=)의 이름(수는 아직 모름 → 안 붙임). */
function InboxFallbackTitle() {
  const tab = useSearchParams().get('tab') ?? 'notifications';
  return <InboxTopBarTitle key={tab} tab={tab} />;
}

/**
 * PO 판단(4688) — 일감 탭 밖 목적지의 **«경로 → 제목» 표 하나**(키 = `app/(authenticated)/` 아래 경로 폴더 · 이동 주소가 아니다 — 주소는
 * nav-v3 목적지 모듈이 정한다). 각 경로의 loading.tsx가 이 표로 폴백을 쥐고, 화면은 같은 제목 컴포넌트로 슬롯을 채운다(정의 한 곳).
 * 일감 탭은 4291(WorkTabsFrame)이 따로 쥔다.
 * 목록 전용: 폴더의 loading.tsx는 그 아래 상세(`chats/[conversation_id]` · `goals/[id]`)도 덮는다 — 상세는 제목(뒤로 · 이름)이 다르고 칩이 없으니,
 * 도착 주소의 마지막 조각이 이 폴더 이름일 때(= 목록 자체)만 쥔다. 상세 로딩 중엔 예전처럼 비워 둔다(틀린 제목 · 칩을 잠깐 세우지 않게).
 */
export const FLAT_ROUTE_TOP_BAR = {
  more: { Title: MoreTopBarTitle, showContextChip: true },
  inbox: { Title: InboxFallbackTitle, showContextChip: true },
  chats: { Title: ChatsTopBarTitle, showContextChip: true },
  channel: { Title: () => <ChannelTopBarTitle />, showContextChip: true },
  rewards: { Title: RewardsTopBarTitle, showContextChip: true },
  '[ws]/[proj]/goals': { Title: GoalsTopBarTitle, showContextChip: true },
  '[ws]/[proj]/loops': { Title: LoopsTopBarTitle, showContextChip: true },
  '[ws]/[proj]/docs': { Title: DocsTopBarTitle, showContextChip: true },
  '[ws]/[proj]/storage': { Title: () => <StorageTopBarTitle />, showContextChip: true },
  activity: { Title: ActivityTopBarTitle, showContextChip: true },
  'organization/workforce': { Title: AgentsTopBarTitle, showContextChip: true },
} as const satisfies Record<string, { Title: () => ReactNode; showContextChip: boolean }>;

export type FlatRoute = keyof typeof FLAT_ROUTE_TOP_BAR;

/** 프로젝트 자원 부모 경계(`[ws]/[proj]/loading`)용 — 도착 자원 조각이 표에 있으면 그 경로. */
export function projectRouteOf(segment: string | undefined): FlatRoute | null {
  const key = `[ws]/[proj]/${segment ?? ''}`;
  return key in FLAT_ROUTE_TOP_BAR ? (key as FlatRoute) : null;
}

/** 도착 주소가 그 폴더의 목록 자체인가(마지막 조각 = 폴더 이름). 상세(`…/chats/<id>`)면 아니다. */
export function isRouteListPath(route: FlatRoute, pathname: string | null): boolean {
  const last = (pathname ?? '').split('/').filter(Boolean).pop();
  return last === route.split('/').pop();
}

/** loading.tsx 한 줄 — 그 경로의 목록으로 올 때 제목을 폴백으로 쥔다. 결재는 탭이 바뀌면 다시 쥔다(key). */
export function RouteTopBarFallback({ route }: { route: FlatRoute }) {
  const entry = FLAT_ROUTE_TOP_BAR[route];
  const pathname = usePathname();
  const tab = useSearchParams().get('tab');
  if (!isRouteListPath(route, pathname)) return null;
  return <TopBarFallbackHolder key={route === 'inbox' ? `inbox:${tab ?? ''}` : route} title={<entry.Title />} showContextChip={entry.showContextChip} />;
}
