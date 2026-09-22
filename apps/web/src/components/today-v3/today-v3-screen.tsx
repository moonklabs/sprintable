'use client';

import { useTranslations, useLocale } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { useTodaySnapshot } from '@/components/org-briefing/use-today-snapshot';
import { EMPTY_TODAY_SNAPSHOT, type TodayCount, type TodaySnapshot } from '@/components/org-briefing/derive-today';
import { TodayV3Decisions } from './today-v3-decisions';
import { TodayV3AgentProgress } from './today-v3-agent-progress';
import { useMyOrgRole } from './use-my-org-role';
import { NavV3Sidebar } from '@/components/nav/nav-v3-item-list';
import { MobileTabBar } from '@/components/nav/mobile-tab-bar';
import { useChatUnreadTotal } from '@/hooks/use-chat-unread-total';
import { DEFAULT_NAV_V3_FLAGS, type NavV3Flags } from '@/lib/nav-v3-destinations';

/**
 * story #3962(E-UX-OVERHAUL·「오늘」 구현 3/N·FE) — 시안 ①(artifact d31b9e6d) 그대로.
 * CHANGES-2(페드루 PO, 2026-09-16 16:08Z) — 내 결정·진행 中은 v3 전용 컴포넌트
 * (`today-v3-decisions.tsx`/`today-v3-agent-progress.tsx`)로 짓는다 — 옛
 * `today-sections.tsx`(story #3831, org-briefing 전용)에 없는 시안 ① 요소 2개
 * (위험 등급 태그+저위험 모아 승인 자리·「정지」 자리)가 필요해서다. 옛 컴포넌트는
 * 무접촉(org-briefing이 그대로 쓴다) — v3는 같은 `TodaySnapshot`/`derive-today.ts`
 * 타입만 공유하고 렌더는 독립.
 */

function formatTodayCount(value: TodayCount | undefined, unmeasuredLabel: string): string {
  if (!value || !value.measured) return unmeasuredLabel;
  return String(value.count);
}

function TodayResultsSummary({ snapshot }: { snapshot: TodaySnapshot }) {
  const t = useTranslations('todayV3');
  const unmeasured = t('unmeasured');
  return (
    <section aria-label={t('resultsSectionTitle')}>
      <div className="mb-2.5 flex items-baseline gap-2.5">
        <h2 className="text-sm font-semibold text-foreground">{t('resultsSectionTitle')}</h2>
        <span className="text-[11px] text-muted-foreground">{t('resultsHint')}</span>
      </div>
      <p className="text-xs text-muted-foreground" data-testid="today-v3-results-summary">
        {t('resultsSummaryLine', {
          landed: formatTodayCount(snapshot.landedToday, unmeasured),
          qaPassed: formatTodayCount(snapshot.qaPassedToday, unmeasured),
          openDefects: formatTodayCount(snapshot.openDefects, unmeasured),
          published: snapshot.published.count,
        })}
      </p>
    </section>
  );
}

function TodayV3Topbar({ needsMeCount }: { needsMeCount: number }) {
  const t = useTranslations('todayV3');
  return (
    <div className="flex h-14 shrink-0 items-center gap-4 border-b border-border bg-card px-5" data-testid="today-v3-topbar">
      <div className="flex h-[34px] max-w-[420px] flex-1 items-center gap-2 rounded-md border border-border bg-muted px-3 text-sm text-muted-foreground">
        <span>{t('searchPlaceholder')}</span>
      </div>
      <div className="relative ml-auto flex items-center gap-3.5">
        {needsMeCount > 0 ? (
          <Badge variant="warning" data-testid="today-v3-bell-badge">{needsMeCount}</Badge>
        ) : null}
      </div>
    </div>
  );
}

export function TodayV3Screen({ flags = DEFAULT_NAV_V3_FLAGS }: { flags?: NavV3Flags }) {
  const { data, loadError, retry } = useTodaySnapshot();
  const snapshot = data ?? EMPTY_TODAY_SNAPSHOT;
  const t = useTranslations('todayV3');
  const tc = useTranslations('common');
  const locale = useLocale();
  const myRole = useMyOrgRole();
  const isAdminOrOwner = myRole === 'owner' || myRole === 'admin';
  // story #4006 AC8 — 좁은 폭(lg 미만) 하단 탭 바. 이 화면은 org_id/team_member_id를
  // (authenticated) 밖이라 DashboardContext로 못 받는다(useMyOrgRole 동형 제약) —
  // currentTeamMemberId 없이 부르면 초기 unread-count fetch는 그대로 되고 SSE
  // 실시간 갱신만 빠진다(마운트 스냅숏, 화면 전환마다 재계산돼 충분한 근사치).
  const chatUnreadTotal = useChatUnreadTotal();

  const dateLabel = new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());
  // story #3962 ④(FE 계산) — 서버는 agent.id를 안 준다(derive-today.ts가 agentName만
  // 파싱), 같은 이름의 다른 에이전트가 동시에 뛰는 경우 과소산정될 수 있으나 "화면
  // 헤더 1줄" 용도의 근사치(§13류 정밀 집계가 아니다)로는 충분 — 새 API 0.
  const distinctAgentCount = new Set(snapshot.agentProgress.map((a) => a.agentName)).size;

  return (
    <div className="flex h-screen min-h-0 flex-col bg-muted/20" data-testid="today-v3-screen">
      <div className="flex min-h-0 flex-1">
        <NavV3Sidebar flags={flags} activeKey="today" todayBadgeCount={snapshot.needsMeCount} />
        <div className="flex min-w-0 flex-1 flex-col">
          <TodayV3Topbar needsMeCount={snapshot.needsMeCount} />
          <div className="flex min-h-0 flex-1">
            {/* story #4006 AC3/AC4 — lg 미만은 목록(이 칸)이 전폭(오늘 화면은 상세 칸이
                항상 빈 셸 자리라 실제로 열 것이 없다 — §3 "선택→상세" 토글은 대상/대화
                칸에 실 콘텐츠가 생기는 후속 스토리 스코프, 지금은 목록 칸만 있으면 된다). */}
            <section className="min-h-0 w-full shrink-0 overflow-auto border-r border-border p-5 lg:w-[392px]" data-testid="today-v3-today-column">
              <p className="text-xs text-muted-foreground">{dateLabel}</p>
              <h1 className="mb-1 text-[26px] font-bold tracking-tight text-foreground">{t('title')}</h1>
              <p className="mb-6 text-xs text-muted-foreground">
                {t('headerSummary', { decisions: snapshot.needsMeCount, agents: distinctAgentCount })}
              </p>

              {loadError ? (
                <div className="flex flex-col items-center gap-3 py-10 text-center">
                  <p role="alert" className="text-sm text-destructive">{t('loadErrorTitle')}</p>
                  <Button size="sm" variant="outline" onClick={retry}>{tc('retry')}</Button>
                </div>
              ) : !data ? (
                <div className="space-y-3" aria-hidden="true" data-testid="today-v3-loading">
                  <Skeleton className="h-24 w-full" />
                  <Skeleton className="h-24 w-full" />
                </div>
              ) : (
                <div className="space-y-6">
                  <TodayV3Decisions
                    items={snapshot.needsMe} count={snapshot.needsMeCount}
                    isAdminOrOwner={isAdminOrOwner} onActionSuccess={retry}
                  />
                  <TodayV3AgentProgress items={snapshot.agentProgress} onActionSuccess={retry} />
                  <TodayResultsSummary snapshot={snapshot} />
                </div>
              )}
            </section>

            {/* story #3962 「하지 않는 것: 대화/일감 화면(별 카드)」 — 대상·대화 컬럼은
                3단 프레임(시안 셸)만 서고 내용은 빈 자리(선택 없음 상태). story #4006
                AC3 — lg 미만에선 이 빈 셸 2칸이 목록 칸과 겹쳐 넘칠 이유가 없으니 그냥
                숨긴다(§3, 실 콘텐츠가 없는 자리를 토글할 필요 0). */}
            <section
              className="hidden flex-1 items-center justify-center border-r border-border bg-background/60 lg:flex"
              data-testid="today-v3-target-column"
            >
              <p className="text-sm text-muted-foreground">{t('targetColumnEmpty')}</p>
            </section>
            <section
              className="hidden w-[384px] shrink-0 items-center justify-center bg-card lg:flex"
              data-testid="today-v3-chat-column"
            >
              <p className="text-sm text-muted-foreground">{t('chatColumnEmpty')}</p>
            </section>
          </div>
        </div>
      </div>
      <MobileTabBar chatUnreadTotal={chatUnreadTotal} navV3Flags={flags} />
    </div>
  );
}
