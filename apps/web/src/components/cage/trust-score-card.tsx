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
}

interface TrustScoreData {
  member_id: string;
  scores: RoleScore[];
  window_days: number;
  computed_at: string;
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

  const hasData = (data?.scores ?? []).some((s) => s.total_verdicts > 0);

  if (!hasData) {
    return <TrustScoreEmpty compact={compact} />;
  }

  const scores = data!.scores;
  const totalVerdicts = scores.reduce((s, r) => s + r.total_verdicts, 0);
  const cleanPasses = scores.reduce((s, r) => s + r.clean_pass_verdicts, 0);
  const corrections = totalVerdicts - cleanPasses;
  const overallRate = totalVerdicts > 0 ? cleanPasses / totalVerdicts : null;

  if (compact) {
    const hasCorrections = corrections > 0;
    return (
      <span
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium tabular-nums ${
          hasCorrections
            ? 'border-warning-border bg-warning-tint text-warning'
            : 'border-border bg-muted/40 text-foreground'
        }`}
      >
        {pct(overallRate)}
      </span>
    );
  }

  return (
    <div className="space-y-4 rounded-xl border border-border bg-card p-4">
      {/* 주지표 */}
      <div className="flex items-end justify-between">
        <div>
          <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">{t('trustScoreLabel')}</p>
          <p className="mt-1 text-3xl font-bold tabular-nums text-foreground">{pct(overallRate)}</p>
          <p className="text-xs text-muted-foreground">{t('trustScoreWindowHint', { days: data!.window_days })}</p>
        </div>
        {corrections > 0 && (
          <span className="rounded-md border border-warning-border bg-warning-tint px-2 py-1 text-xs font-medium text-warning">
            {t('correctionRounds', { count: corrections })}
          </span>
        )}
      </div>

      {/* 전적 trio */}
      <div className="grid grid-cols-3 gap-2">
        {([
          { label: t('totalReviews'), value: totalVerdicts },
          { label: t('cleanPasses'), value: cleanPasses },
          { label: t('corrections'), value: corrections },
        ] as { label: string; value: number }[]).map(({ label, value }) => (
          <div key={label} className="rounded-lg border border-border bg-muted/30 p-2 text-center">
            <p className="text-lg font-bold tabular-nums text-foreground">{value}</p>
            <p className="text-[10px] text-muted-foreground">{label}</p>
          </div>
        ))}
      </div>

      {/* 역할별 bar */}
      {scores.filter((s) => s.total_verdicts > 0).length > 0 && (
        <div className="space-y-2">
          <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">{t('byRole')}</p>
          {scores.filter((s) => s.total_verdicts > 0).map((role) => (
            <div key={role.role_key} className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">{role.role_label}</span>
                <span className="tabular-nums text-foreground">{pct(role.clean_pass_rate)}</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
                <div
                  className="h-full rounded-full bg-foreground/40 transition-all"
                  style={{ width: role.clean_pass_rate !== null ? `${Math.round(role.clean_pass_rate * 100)}%` : '0%' }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
