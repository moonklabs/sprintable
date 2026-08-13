'use client';

import { useTranslations } from 'next-intl';
import { CheckCircle2, AlertTriangle, Circle } from 'lucide-react';
import { isPending, minutesSince, type Overview, type RecentChange } from './types';

// verb → 표시 카피 키 + 톤(아이콘 색). BE는 id+enum+time만(raw payload 비노출) → enum→카피 조합.
const VERB_META: Record<string, { key: string; tone: 'ok' | 'warn' }> = {
  'story.created': { key: 'ccChangeStoryCreated', tone: 'ok' },
  'story.status_changed': { key: 'ccChangeStoryStatus', tone: 'ok' },
  'sprint.started': { key: 'ccChangeSprintStarted', tone: 'ok' },
  'sprint.closed': { key: 'ccChangeSprintClosed', tone: 'ok' },
  'doc.created': { key: 'ccChangeDocCreated', tone: 'ok' },
  'agent_run.completed': { key: 'ccChangeRunCompleted', tone: 'ok' },
  'agent_run.failed': { key: 'ccChangeRunFailed', tone: 'warn' },
};

function PendingSlot({ label }: { label: string }) {
  return <p className="text-[11px] text-muted-foreground/60">{label}</p>;
}

function RecentRow({ change, resolveName, t }: { change: RecentChange; resolveName: (id: string | null | undefined) => string | null; t: ReturnType<typeof useTranslations<'dashboard'>> }) {
  const meta = VERB_META[change.verb];
  const tone = meta?.tone ?? (change.verb.includes('fail') ? 'warn' : 'ok');
  const label = meta ? t(meta.key) : t('ccChangeGeneric', { object: change.object_type });
  const resolved = resolveName(change.object_id); // epic/member 등 가용 시 제목 보강(없으면 enum 카피만)
  const mins = minutesSince(change.occurred_at);
  const ago = mins < 60 ? t('ccMinAgo', { n: mins }) : mins < 1440 ? t('ccHourAgo', { n: Math.floor(mins / 60) }) : t('ccDayAgo', { n: Math.floor(mins / 1440) });
  return (
    <li className="flex items-center gap-2 text-[11px]">
      {tone === 'warn' ? <AlertTriangle className="size-3 shrink-0 text-warning-strong" /> : <CheckCircle2 className="size-3 shrink-0 text-success" />}
      <span className="min-w-0 flex-1 truncate text-foreground">{label}{resolved ? <span className="text-muted-foreground"> · {resolved}</span> : null}</span>
      <span className="shrink-0 tabular-nums text-muted-foreground/70">{ago}</span>
    </li>
  );
}

export function OverviewZone({ data, resolveName }: {
  data: Overview | null;
  resolveName: (id: string | null | undefined) => string | null;
}) {
  const t = useTranslations('dashboard');
  const ps = data?.project_status;
  const epics = ps?.epics ?? [];
  const outcome = ps?.outcome;
  const recent = ps?.recent_changes ?? [];

  // story #2338 후속(2026-07-30, 유나양 §11-5 규격 · flow-board-unified-ia) — 여러 개의
  // "아직 못 그린다"를 항목마다 흩어 놓으면 화면이 변명으로 가득 차 보인다(§11-5-(2)).
  // 한 칸에 모으고, 재료가 들어오면 그 항목만 "스스로" 빠진다(§11-5-(5)) — 셋 다 빠지면
  // 칸 자체가 사라진다(정상은 "말이 없는 것"·"모두 표시 중입니다"로 바꾸지 않는다).
  const overdueStillPending = !!ps && !isPending(ps.risk) && isPending(ps.risk.overdue);
  // cost_trend: BE는 이미 실 객체를 보낸다(더 이상 리터럴 pending_data가 아니다) — 그래서
  // isPending()은 만료 조건이 될 수 없다(#2338 AC1). 만료 조건 = agent_runs.cost_usd가
  // 실제로 채워지기 시작했는가(0이 "비용 없음 확인"이 아니라 "안 잰다"인 동안은 계속 보류).
  const costTrendHasSignal = !!ps && !isPending(ps.cost_trend) &&
    (ps.cost_trend.total_cost_usd > 0 || ps.cost_trend.points.some((p) => p.cost_usd > 0));
  const notYetShown: string[] = [];
  if (overdueStillPending) notYetShown.push(t('ccItemOverdue'));
  if (!costTrendHasSignal) notYetShown.push(t('ccItemCostTrend'));

  return (
    <section aria-label={t('ccZoneOverview')} className="space-y-4 rounded-xl border border-border bg-card/40 p-3">
      <h3 className="text-sm font-semibold text-foreground">{t('ccZoneOverview')}</h3>

      {/* 지표: 에픽 진척(실) + 성과(가설 적중·실) */}
      <div className="space-y-2.5">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium text-foreground">{t('ccEpicsTitle')}</span>
          {outcome ? (
            <span className="text-[11px] text-muted-foreground">
              {t('ccOutcome')} <span className="tabular-nums text-foreground">{outcome.total > 0 ? `${outcome.hit}/${outcome.total}` : '—'}</span>
            </span>
          ) : null}
        </div>
        {epics.length > 0 ? (
          <ul className="space-y-2">
            {epics.slice(0, 6).map((e) => (
              <li key={e.epic_id} className="space-y-1">
                <div className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="min-w-0 truncate text-foreground">{e.title}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">{e.done}/{e.total} · {e.completion_pct}%</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-foreground/60" style={{ width: `${e.completion_pct}%` }} />
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[11px] text-muted-foreground">{t('ccEpicsEmpty')}</p>
        )}
        {/* story #2338 — BE는 risk/cycle_time/contribution 전부 실 객체를 보낸다(더 이상
            통짜 PendingData가 아니다). risk 안의 overdue «필드 하나»만 아직 BE 미구현이라
            그 필드에만 isPending을 건다 — risk «전체»에 걸면 이 실 객체와 영원히 안 맞아
            렌더 코드에 도달하지 못한다(#2338이 잡은 사고). blocked는 #2224 판정대로
            안 그린다(item_dependency 엣지 org 전체 0 — 상시 0이라 되살릴 값이 없다). */}
        {ps && !isPending(ps.risk) ? (
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-muted-foreground">{t('ccRiskFailedRuns')}</span>
            <span className="tabular-nums text-foreground">{ps.risk.failed_runs}</span>
          </div>
        ) : (
          <PendingSlot label={t('ccRiskPending')} />
        )}
        {ps && !isPending(ps.cycle_time) ? (
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-muted-foreground">{t('ccCycleTitle')}</span>
            <span className="tabular-nums text-foreground">
              {ps.cycle_time.sample > 0 ? t('ccCycleValue', { days: ps.cycle_time.avg_days ?? 0, n: ps.cycle_time.sample }) : t('ccCycleEmpty')}
            </span>
          </div>
        ) : (
          <PendingSlot label={t('ccCyclePending')} />
        )}
        {ps && !isPending(ps.contribution) ? (
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-muted-foreground">{t('ccContributionTitle')}</span>
            <span className="tabular-nums text-foreground">
              {t('ccContributionValue', { agent: ps.contribution.agent, human: ps.contribution.human, unassigned: ps.contribution.unassigned })}
            </span>
          </div>
        ) : (
          <PendingSlot label={t('ccContributionPending')} />
        )}
      </div>

      {/* story #2338 후속 — §11-5 문안 확定 그대로: "아직 표시하지 않는 것 — {항목}" 한 줄 +
          "준비되는 대로 표시됩니다." 시점 약속·사과 없음. 항목 0개면 칸 자체를 안 그린다. */}
      {notYetShown.length > 0 ? (
        <p className="border-t border-border pt-3 text-[11px] text-muted-foreground/60">
          {t('ccNotYetShownLabel', { items: notYetShown.join(' · ') })}
          <br />
          {t('ccNotYetShownFooter')}
        </p>
      ) : null}

      {/* 최근 변화: verb+object_type 카피 조합(BE id-only·raw payload 없음)·슬림 */}
      <div className="space-y-1.5 border-t border-border pt-3">
        <span className="text-[11px] font-medium text-foreground">{t('ccRecentTitle')}</span>
        {recent.length > 0 ? (
          <ul className="space-y-1">
            {recent.slice(0, 8).map((c, i) => <RecentRow key={`${c.verb}-${c.object_id ?? i}`} change={c} resolveName={resolveName} t={t} />)}
          </ul>
        ) : (
          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><Circle className="size-2.5" />{t('ccRecentEmpty')}</p>
        )}
      </div>
    </section>
  );
}
