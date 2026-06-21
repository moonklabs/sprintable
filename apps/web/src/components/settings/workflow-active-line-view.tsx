'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { GitBranch, ArrowRight, ShieldOff } from 'lucide-react';

/**
 * E-DG S29 좌-pane — 현 active published 라인 정의 보기(read-only). 데이터 = GET
 * /api/workflow-line-config/active?entity_type=&project_id=(디디 #1637). 우 pane(dry-run)와
 * 한 탭(workflow-policies). 활성 라인 없으면 default-off 안내. config.steps = from→to 시퀀스. 신규 토큰 0.
 */
const ENTITY_TYPES = ['story', 'doc', 'hypothesis', 'epic', 'sprint'] as const;

interface ActiveStep { from_status?: string | null; to_status?: string | null }
interface ActiveLine {
  entity_type: string;
  has_active: boolean;
  definition_id?: string | null;
  config?: { steps?: ActiveStep[] } | null;
}

export function WorkflowActiveLineView({ projectId }: { projectId?: string | null }) {
  const t = useTranslations('settings');
  const [entityType, setEntityType] = useState<string>('story');
  const [data, setData] = useState<ActiveLine | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const q = new URLSearchParams({ entity_type: entityType });
      if (projectId) q.set('project_id', projectId);
      const res = await fetch(`/api/workflow-line-config/active?${q.toString()}`);
      setData(res.ok ? ((await res.json()) as ActiveLine) : null);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [entityType, projectId]);

  useEffect(() => { void load(); }, [load]);

  const steps = data?.config?.steps ?? [];

  return (
    <div className="space-y-3 rounded-xl border border-border bg-muted/10 p-3">
      <div className="flex items-center gap-2">
        <GitBranch className="size-4 shrink-0 text-muted-foreground" />
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('simActiveLine')}</p>
        <select
          value={entityType}
          onChange={(e) => setEntityType(e.target.value)}
          className="ml-auto h-7 rounded-md border border-border bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
        >
          {ENTITY_TYPES.map((et) => <option key={et} value={et}>{et}</option>)}
        </select>
      </div>

      {loading ? (
        <p className="text-xs text-muted-foreground">…</p>
      ) : !data || !data.has_active ? (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ShieldOff className="size-3.5 shrink-0" />
          {t('activeLineNone')}
        </div>
      ) : steps.length ? (
        <ul className="space-y-0.5">
          {steps.map((s, i) => (
            <li key={i} className="flex flex-wrap items-center gap-1.5 text-xs text-foreground">
              <span className="font-mono">{s.from_status ?? '—'}</span>
              <ArrowRight className="size-3 shrink-0 text-muted-foreground" />
              <span className="font-mono">{s.to_status ?? '—'}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">{t('activeLineNoSteps')}</p>
      )}
    </div>
  );
}
