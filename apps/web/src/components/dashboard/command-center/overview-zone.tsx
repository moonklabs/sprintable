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
      {tone === 'warn' ? <AlertTriangle className="size-3 shrink-0 text-warning" /> : <CheckCircle2 className="size-3 shrink-0 text-success" />}
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
        {/* 신규 지표(CC-BE.2) — pending이면 "준비중" 미세표시(mock/0 금지·해당 metric만) */}
        {ps && isPending(ps.risk) ? <PendingSlot label={t('ccRiskPending')} /> : null}
        {ps && isPending(ps.cycle_time) ? <PendingSlot label={t('ccCyclePending')} /> : null}
        {ps && isPending(ps.contribution) ? <PendingSlot label={t('ccContributionPending')} /> : null}
      </div>

      {/* 비용 추세: pending이면 "준비중"(점 아닌 추세). CC-BE.2 shape 도착 시 sparkline(forward-compat). */}
      <div className="space-y-1.5 border-t border-border pt-3">
        <span className="text-[11px] font-medium text-foreground">{t('ccCostTrendTitle')}</span>
        {ps && isPending(ps.cost_trend) ? (
          <PendingSlot label={t('ccCostTrendPending')} />
        ) : (
          <p className="text-[11px] text-muted-foreground">{t('ccCostTrendPending')}</p>
        )}
      </div>

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
