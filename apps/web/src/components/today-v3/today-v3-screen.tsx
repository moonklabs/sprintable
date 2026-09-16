'use client';

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useTodaySnapshot } from '@/components/org-briefing/use-today-snapshot';
import { EMPTY_TODAY_SNAPSHOT, type TodayCount, type TodaySnapshot } from '@/components/org-briefing/derive-today';
import { NeedsMeSection, AgentProgressSection } from '@/components/org-briefing/today-sections';

/**
 * story #3962(E-UX-OVERHAUL·「오늘」 구현 3/N·FE) — 시안 ①(artifact d31b9e6d) 그대로.
 * 본문 데이터 구역(내 결정·진행 中)은 org-briefing이 이미 쓰는 검증된 컴포넌트
 * (`today-sections.tsx::NeedsMeSection`/`AgentProgressSection`, story #3831)를 그대로
 * 재사용한다(새 렌더 로직 0) — 이 파일이 새로 짓는 건 v3 셸(좌 nav·상단·3단 프레임)
 * 과 「오늘 결과」 4수 요약 한 줄(TodayResultsSummary, story #3959 3필드+기존
 * published_today)뿐이다. 대상(중앙)·대화(우측) 컬럼은 이 카드 스코프 밖(「하지
 * 않는 것: 대화/일감 화면」) — 3단 프레임 자체(시안 픽셀)는 서되, 내용은 빈 자리.
 */

const NAV_ITEMS: { key: string; href: string; active?: boolean }[] = [
  { key: 'navToday', href: '/today', active: true },
  { key: 'navChats', href: '/chats' },
  { key: 'navWork', href: '/flow' },
  { key: 'navResults', href: '/organization/insights-board' },
  { key: 'navConnectRules', href: '/organization/channels' },
];

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

function TodayV3Nav({ needsMeCount }: { needsMeCount: number }) {
  const t = useTranslations('todayV3');
  return (
    <aside className="flex w-[216px] shrink-0 flex-col border-r border-border bg-card p-3" data-testid="today-v3-nav">
      <nav className="mt-1 flex flex-col gap-0.5">
        {NAV_ITEMS.map((item) => (
          <Link
            key={item.key}
            href={item.href}
            data-testid={`today-v3-nav-${item.key}`}
            className={
              item.active
                ? 'flex items-center gap-2.5 rounded-md bg-primary/10 px-2.5 py-2 text-sm font-medium text-primary'
                : 'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-muted-foreground hover:bg-muted'
            }
          >
            <span className="min-w-0 flex-1 truncate">{t(item.key)}</span>
            {item.key === 'navToday' && needsMeCount > 0 ? (
              <span className="flex h-[19px] min-w-[19px] items-center justify-center rounded-full bg-primary px-1 text-[11.5px] font-bold text-primary-foreground">
                {needsMeCount}
              </span>
            ) : null}
          </Link>
        ))}
      </nav>
    </aside>
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

export function TodayV3Screen() {
  const { data, loadError, retry } = useTodaySnapshot();
  const snapshot = data ?? EMPTY_TODAY_SNAPSHOT;
  const t = useTranslations('todayV3');
  const tc = useTranslations('common');
  const locale = useLocale();

  const dateLabel = new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());
  // story #3962 ④(FE 계산) — 서버는 agent.id를 안 준다(derive-today.ts가 agentName만
  // 파싱), 같은 이름의 다른 에이전트가 동시에 뛰는 경우 과소산정될 수 있으나 "화면
  // 헤더 1줄" 용도의 근사치(§13류 정밀 집계가 아니다)로는 충분 — 새 API 0.
  const distinctAgentCount = new Set(snapshot.agentProgress.map((a) => a.agentName)).size;

  return (
    <div className="flex h-screen min-h-0 bg-muted/20" data-testid="today-v3-screen">
      <TodayV3Nav needsMeCount={snapshot.needsMeCount} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TodayV3Topbar needsMeCount={snapshot.needsMeCount} />
        <div className="flex min-h-0 flex-1">
          <section className="w-[392px] shrink-0 overflow-auto border-r border-border p-5" data-testid="today-v3-today-column">
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
                <Card className="h-24 animate-pulse bg-muted/30" />
                <Card className="h-24 animate-pulse bg-muted/30" />
              </div>
            ) : (
              <div className="space-y-6">
                <NeedsMeSection items={snapshot.needsMe} count={snapshot.needsMeCount} />
                <AgentProgressSection items={snapshot.agentProgress} />
                <TodayResultsSummary snapshot={snapshot} />
              </div>
            )}
          </section>

          {/* story #3962 「하지 않는 것: 대화/일감 화면(별 카드)」 — 대상·대화 컬럼은
              3단 프레임(시안 셸)만 서고 내용은 빈 자리(선택 없음 상태). */}
          <section
            className="flex flex-1 items-center justify-center border-r border-border bg-background/60"
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
  );
}
