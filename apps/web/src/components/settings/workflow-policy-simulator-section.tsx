'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Shield, ShieldCheck, ShieldX, Play, ArrowRight } from 'lucide-react';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { Field } from '@/components/ds/field';
import { Input } from '@/components/ds/input';
import { NativeSelect } from '@/components/ds/select';
import { Tag } from './settings-parts';

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
const DECISION_META: Record<string, { tone: 'done' | 'needs-hand' | 'failed'; labelKey: string }> = {
  auto_merge: { tone: 'done', labelKey: 'simDecisionAuto' },
  ask_human: { tone: 'needs-hand', labelKey: 'simDecisionAsk' },
  block: { tone: 'failed', labelKey: 'simDecisionBlock' },
};
// gate_type → Shield 어휘(S24 미러). human=결재 / policy=차단 / merge=병합검증.
const GATE_META: Record<string, { tone: 'needs-hand' | 'failed' | 'action'; Icon: typeof Shield }> = {
  human: { tone: 'needs-hand', Icon: Shield },
  policy: { tone: 'failed', Icon: ShieldX },
  merge: { tone: 'action', Icon: ShieldCheck },
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

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('simEntityType')}>
          {(c) => (
            <NativeSelect {...c} value={entityType} onChange={(e) => setEntityType(e.target.value)}>
              {ENTITY_TYPES.map((et) => <option key={et} value={et}>{et}</option>)}
            </NativeSelect>
          )}
        </Field>
        <Field label={t('simEntityId')}>
          {(c) => <Input {...c} value={entityId} onChange={(e) => setEntityId(e.target.value)} placeholder="uuid" />}
        </Field>
        <Field label={t('simFromStatus')}>
          {(c) => <Input {...c} value={fromStatus} onChange={(e) => setFromStatus(e.target.value)} placeholder={t('simOptional')} />}
        </Field>
        <Field label={t('simToStatus')}>
          {(c) => <Input {...c} value={toStatus} onChange={(e) => setToStatus(e.target.value)} placeholder="merged" />}
        </Field>
      </div>

      <Button type="button" variant="primary" iconStart={<Play className="size-3.5" aria-hidden />} disabled={!canRun} loading={loading} onClick={() => void run()}>
        {loading ? t('simRunning') : t('simRun')}
      </Button>

      {error ? <Banner tone="failed">{error}</Banner> : null}

      {result ? (
        <div className="space-y-3 rounded-ds-control border border-ds-line bg-ds-surface-high p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Tag tone={result.proceeds ? 'done' : 'failed'}>
              {result.proceeds ? t('simProceeds') : t('simBlocked')}
            </Tag>
            <span className="text-ds-small text-ds-ink-3">{t('simMode')}: {result.mode}</span>
            {!result.matched ? <span className="text-ds-small text-ds-ink-3">· {t('simUngoverned')}</span> : null}
            {result.blocking_reason ? <span className="text-ds-small text-ds-failed">· {result.blocking_reason}</span> : null}
          </div>

          <div className="space-y-1">
            <p className="text-ds-small font-semibold text-ds-ink-2">{t('simAxisRouting')}</p>
            {result.routing_path.length ? (
              <ul className="space-y-1">
                {result.routing_path.map((s, i) => (
                  <li key={i} className="flex flex-wrap items-center gap-1.5 text-ds-small text-ds-ink">
                    <span className="font-mono">{s.from_status ?? '—'}</span>
                    <ArrowRight className="size-3 shrink-0 text-ds-ink-3" aria-hidden />
                    <span className="font-mono">{s.to_status}</span>
                    {s.route ? <Tag>{s.route}</Tag> : null}
                  </li>
                ))}
              </ul>
            ) : <p className="text-ds-small text-ds-ink-3">{t('simNone')}</p>}
          </div>

          <div className="space-y-1">
            <p className="text-ds-small font-semibold text-ds-ink-2">{t('simAxisGates')}</p>
            {result.gates.length ? (
              <div className="flex flex-wrap gap-1.5">
                {result.gates.map((g, i) => {
                  const gm = (g.gate_type && GATE_META[g.gate_type]) || GATE_META.human;
                  const GIcon = gm.Icon;
                  return (
                    <Tag key={i} tone={gm.tone} className="gap-1">
                      <GIcon className="size-3 shrink-0" aria-hidden />
                      {g.gate_type ?? 'gate'}{g.target ? ` · ${g.target}` : ''}
                    </Tag>
                  );
                })}
              </div>
            ) : <p className="text-ds-small text-ds-ink-3">{t('simNone')}</p>}
          </div>

          <div className="space-y-1">
            <p className="text-ds-small font-semibold text-ds-ink-2">{t('simAxisTrust')}</p>
            <div className="flex flex-wrap items-center gap-2">
              {decisionMeta ? <Tag tone={decisionMeta.tone}>{t(decisionMeta.labelKey)}</Tag> : null}
              <span className="text-ds-small text-ds-ink-3">
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
