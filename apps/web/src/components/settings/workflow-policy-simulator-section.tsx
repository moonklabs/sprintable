'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Shield, ShieldCheck, ShieldX, Play, ArrowRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

/**
 * E-DG S29 — workflow line policy dry-run simulator(admin·publish 前 시뮬레이션).
 * 우 pane = dry-run preview 3축(①routing_path ②gates ③trust_branch). 데이터 = POST
 * /api/workflow-line-config/resolve-preview(디디 #1633 계약). 신규 토큰 0(success/warning/destructive/info/chip 재사용).
 * ⚠️ 좌 pane(현 published config 보기)는 데이터 소스 확정 후 별도(이 컴포넌트 우측 시뮬레이터부터).
 */
const ENTITY_TYPES = ['story', 'doc', 'hypothesis', 'epic', 'sprint'] as const;

interface PreviewStep { from_status: string | null; to_status: string; route: string | null }
interface PreviewGate { gate_type: string | null; target: string | null; gate_id: string | null }
interface PreviewTrustBranch { trust: number | null; decision: string | null; cold_start: boolean }
interface ResolvePreview {
  mode: string;
  proceeds: boolean;
  matched: boolean;
  blocking_reason: string | null;
  routing_path: PreviewStep[];
  gates: PreviewGate[];
  trust_branch: PreviewTrustBranch;
}

// trust 분기 decision → GateEvidence 어휘 미러(auto/ask/block).
const DECISION_META: Record<string, { variant: 'success' | 'warning' | 'destructive'; labelKey: string }> = {
  auto_merge: { variant: 'success', labelKey: 'simDecisionAuto' },
  ask_human: { variant: 'warning', labelKey: 'simDecisionAsk' },
  block: { variant: 'destructive', labelKey: 'simDecisionBlock' },
};
// gate_type → Shield 어휘(S24 미러). human=결재 / policy=차단 / merge=병합검증.
const GATE_META: Record<string, { variant: 'warning' | 'destructive' | 'info'; Icon: typeof Shield }> = {
  human: { variant: 'warning', Icon: Shield },
  policy: { variant: 'destructive', Icon: ShieldX },
  merge: { variant: 'info', Icon: ShieldCheck },
};

export function WorkflowPolicySimulatorSection() {
  const t = useTranslations('settings');
  const [entityType, setEntityType] = useState<string>('story');
  const [entityId, setEntityId] = useState('');
  const [fromStatus, setFromStatus] = useState('');
  const [toStatus, setToStatus] = useState('');
  const [result, setResult] = useState<ResolvePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const canRun = entityId.trim().length > 0 && toStatus.trim().length > 0 && !loading;

  const run = async () => {
    if (!canRun) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/workflow-line-config/resolve-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entity_type: entityType,
          entity_id: entityId.trim(),
          from_status: fromStatus.trim() || null,
          to_status: toStatus.trim(),
        }),
      });
      if (!res.ok) {
        setError(t('simError'));
        setResult(null);
        return;
      }
      setResult((await res.json()) as ResolvePreview);
    } catch {
      setError(t('simError'));
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  const tb = result?.trust_branch;
  const decisionMeta = tb?.decision ? DECISION_META[tb.decision] : null;
  const inputCls = 'h-9 rounded-md border border-border bg-background px-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40';

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('simEntityType')}
          <select value={entityType} onChange={(e) => setEntityType(e.target.value)} className={inputCls}>
            {ENTITY_TYPES.map((et) => <option key={et} value={et}>{et}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('simEntityId')}
          <input value={entityId} onChange={(e) => setEntityId(e.target.value)} placeholder="uuid" className={inputCls} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('simFromStatus')}
          <input value={fromStatus} onChange={(e) => setFromStatus(e.target.value)} placeholder={t('simOptional')} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('simToStatus')}
          <input value={toStatus} onChange={(e) => setToStatus(e.target.value)} placeholder="merged" className={inputCls} />
        </label>
      </div>

      <Button size="sm" className="gap-1" disabled={!canRun} onClick={() => void run()}>
        <Play className="size-3.5" />
        {loading ? t('simRunning') : t('simRun')}
      </Button>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {result ? (
        <div className="space-y-3 rounded-xl border border-border bg-muted/20 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={result.proceeds ? 'success' : 'destructive'}>
              {result.proceeds ? t('simProceeds') : t('simBlocked')}
            </Badge>
            <span className="text-xs text-muted-foreground">{t('simMode')}: {result.mode}</span>
            {!result.matched ? <span className="text-xs text-muted-foreground">· {t('simUngoverned')}</span> : null}
            {result.blocking_reason ? <span className="text-xs text-destructive">· {result.blocking_reason}</span> : null}
          </div>

          <div className="space-y-1">
            <p className="text-[11px] font-medium text-muted-foreground">{t('simAxisRouting')}</p>
            {result.routing_path.length ? (
              <ul className="space-y-0.5">
                {result.routing_path.map((s, i) => (
                  <li key={i} className="flex flex-wrap items-center gap-1.5 text-xs text-foreground">
                    <span className="font-mono">{s.from_status ?? '—'}</span>
                    <ArrowRight className="size-3 shrink-0 text-muted-foreground" />
                    <span className="font-mono">{s.to_status}</span>
                    {s.route ? <Badge variant="chip">{s.route}</Badge> : null}
                  </li>
                ))}
              </ul>
            ) : <p className="text-xs text-muted-foreground">{t('simNone')}</p>}
          </div>

          <div className="space-y-1">
            <p className="text-[11px] font-medium text-muted-foreground">{t('simAxisGates')}</p>
            {result.gates.length ? (
              <div className="flex flex-wrap gap-1.5">
                {result.gates.map((g, i) => {
                  const gm = (g.gate_type && GATE_META[g.gate_type]) || GATE_META.human;
                  const GIcon = gm.Icon;
                  return (
                    <Badge key={i} variant={gm.variant} className="gap-1" title={g.target ?? undefined}>
                      <GIcon className="size-3 shrink-0" />
                      {g.gate_type ?? 'gate'}{g.target ? ` · ${g.target}` : ''}
                    </Badge>
                  );
                })}
              </div>
            ) : <p className="text-xs text-muted-foreground">{t('simNone')}</p>}
          </div>

          <div className="space-y-1">
            <p className="text-[11px] font-medium text-muted-foreground">{t('simAxisTrust')}</p>
            <div className="flex flex-wrap items-center gap-2">
              {decisionMeta ? <Badge variant={decisionMeta.variant}>{t(decisionMeta.labelKey)}</Badge> : null}
              <span className="text-xs text-muted-foreground">
                {t('simTrust')}: {tb?.trust == null ? t('simTrustNull') : `${Math.round(tb.trust * 100)}%`}
                {tb?.cold_start ? ` · ${t('simColdStart')}` : ''}
              </span>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
