'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

interface RoleScore {
  role_key: string;
  role_label: string;
  clean_pass_verdicts: number;
  total_verdicts: number;
  clean_pass_rate: number | null;
  total_sp: number;
  clean_sp: number;
  weighted_score: number | null;
  // HO-S5/S8 outcome(가설 적중 이력) — 1급 신뢰 신호.
  hit?: number;
  resolved?: number;
  pending?: number;
  hit_rate?: number | null;
}

interface TrustScoreData {
  member_id: string;
  scores: RoleScore[];
  window_days: number;
  computed_at: string;
  // HO-S8: outcome trust(가설 적중) 집계 — 1급. clean_pass는 delivery signal로 격하(2급).
  primary_source?: string;
  hypothesis_hit_rate?: number | null; // 표본0=null=cold-start (0 아님·환원 X)
  resolved?: number;
  hit?: number;
  pending?: number;
  source_breakdown?: Record<string, number>;
}

interface TrustScoreCardProps {
  memberId: string;
  compact?: boolean;
}

function pct(rate: number | null): string {
  if (rate === null) return '—';
  return `${Math.round(rate * 100)}%`;
}

function TrustScoreEmpty({ compact }: { compact?: boolean }) {
  const t = useTranslations('cage');
  if (compact) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-[10px] text-muted-foreground">
        {t('trustScorePending')}
      </span>
    );
  }
  return (
    <div className="rounded-xl border border-dashed border-border bg-muted/20 px-4 py-5 text-center">
      <p className="text-sm font-medium text-muted-foreground">{t('trustScoreNoData')}</p>
      <p className="mt-1 text-xs text-muted-foreground/60">{t('trustScoreNoDataHint')}</p>
    </div>
  );
}

export function TrustScoreCard({ memberId, compact = false }: TrustScoreCardProps) {
  const t = useTranslations('cage');
  const [data, setData] = useState<TrustScoreData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/trust-scores?member_id=${memberId}`)
      .then((r) => r.ok ? r.json() : null)
      .then((json) => setData((json as TrustScoreData | null)))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [memberId]);

  if (loading) {
    return compact ? null : <div className="h-20 animate-pulse rounded-xl bg-muted/30" />;
  }

  const scores = data?.scores ?? [];
  const totalVerdicts = scores.reduce((s, r) => s + r.total_verdicts, 0);
  const cleanPasses = scores.reduce((s, r) => s + r.clean_pass_verdicts, 0);
  const deliveryRate = totalVerdicts > 0 ? cleanPasses / totalVerdicts : null; // 납품 신호(2급·delivery)

  // 1급: outcome trust(가설 적중). null(표본0)=cold-start → "데이터 없음"(0/낮음/빨강 환원 X·AC③).
  const hitRate = data?.hypothesis_hit_rate ?? null;
  const resolved = data?.resolved ?? 0;
  const hit = data?.hit ?? 0;
  const pending = data?.pending ?? 0;

  const hasData = resolved > 0 || pending > 0 || totalVerdicts > 0;
  if (!hasData) {
    return <TrustScoreEmpty compact={compact} />;
  }

  if (compact) {
    // 1급=outcome 적중률. 미측정(null)이면 pending 톤(0%/빨강 환원 X).
    return (
      <span
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium tabular-nums ${
          hitRate === null
            ? 'border-dashed border-border text-muted-foreground'
            : 'border-border bg-muted/40 text-foreground'
        }`}
      >
        {hitRate === null ? t('trustScorePending') : pct(hitRate)}
      </span>
    );
  }

  const roleScores = scores.filter((s) => s.total_verdicts > 0);

  return (
    <div className="space-y-4 rounded-xl border border-border bg-card p-4">
      {/* 1급 주지표 — outcome trust(가설 적중). "통과했다 ≠ 옳았다" */}
      <div>
        <p className="text-[10px] font-mono uppercase tracking-wider text-info">{t('outcomeTrustLabel')}</p>
        {hitRate === null ? (
          <p className="mt-1 text-2xl font-bold italic text-muted-foreground">{t('trustScoreNoData')}</p>
        ) : (
          <p className="mt-1 text-3xl font-bold tabular-nums text-foreground">{pct(hitRate)}</p>
        )}
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t('outcomeSummary', { hit, resolved, days: data!.window_days })}
        </p>
        <p className="text-xs text-muted-foreground">{t('pendingSummary', { pending, resolved })}</p>
      </div>

      {/* 2급 delivery signal — clean_pass 격하(납품 신호). 큰 위계 X·muted. */}
      <div className="rounded-lg border border-border bg-muted/30 p-2.5">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {t('deliverySignalLabel')}
          </span>
          <span className="text-sm font-semibold tabular-nums text-muted-foreground">{pct(deliveryRate)}</span>
        </div>
        {roleScores.length > 0 ? (
          <div className="mt-2 space-y-1.5">
            {roleScores.map((role) => (
              <div key={role.role_key} className="space-y-0.5">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-muted-foreground">{role.role_label}</span>
                  <span className="tabular-nums text-muted-foreground">{pct(role.clean_pass_rate)}</span>
                </div>
                <div className="h-1 w-full overflow-hidden rounded-full bg-border">
                  <div
                    className="h-full rounded-full bg-muted-foreground/40 transition-all"
                    style={{ width: role.clean_pass_rate !== null ? `${Math.round(role.clean_pass_rate * 100)}%` : '0%' }}
                  />
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
