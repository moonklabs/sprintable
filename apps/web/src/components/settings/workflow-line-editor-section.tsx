'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Eye, Pencil, History, GitCompare, Plus, FileCheck2, Send, Save } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { WorkflowActiveLineView } from './workflow-active-line-view';
import { WorkflowPolicySimulatorSection } from './workflow-policy-simulator-section';

/**
 * E-DG S34 — workflow line admin editor(workflow-policies 탭 4모드 확장). org admin이 라인 config를
 * 편집/diff/버전 publish. View(S29 active+simulator)·Edit(config 편집+lint+저장+새 draft)·History(버전 리스트)·
 * Diff(⭐FE 클라 계산 = active+draft config path별 add/change/remove). publish=request-publish→GateInbox gate.
 * BE=S2 governance + #1647(GET config·PATCH·versions list)·design-first 병렬·머지 후 정합. 신규 토큰 0.
 * ⚠️ editor UI = mockup 부재라 textual spec(config JSON + lint)·가디언 정합·#1647 계약 머지 후 검증.
 */
const ENTITY_TYPES = ['story', 'doc', 'hypothesis', 'epic', 'sprint'] as const;
type Mode = 'view' | 'edit' | 'history' | 'diff';

interface Step { from_status?: string | null; to_status?: string | null; [k: string]: unknown }
interface VersionItem {
  id: string;
  version: number;
  status: string;
  lint_status: string;
  updated_at?: string;
  config?: { steps?: Step[] } | null;
}

// 5상태 배지(version.status). publish 거버넌스 lifecycle.
const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'destructive' | 'secondary' | 'chip'> = {
  published: 'success',
  draft: 'secondary',
  pending_publish: 'warning',
  rejected: 'destructive',
  retired: 'chip',
};

const MODES: { key: Mode; labelKey: string; Icon: typeof Eye }[] = [
  { key: 'view', labelKey: 'lineModeView', Icon: Eye },
  { key: 'edit', labelKey: 'lineModeEdit', Icon: Pencil },
  { key: 'history', labelKey: 'lineModeHistory', Icon: History },
  { key: 'diff', labelKey: 'lineModeDiff', Icon: GitCompare },
];

function stepKey(s: Step): string {
  return `${s.from_status ?? '∅'}→${s.to_status ?? '∅'}`;
}

// ⭐ FE 클라 diff: active(published) vs draft config.steps → key별 add/change/remove(BE diff 없음).
function diffSteps(active: Step[], draft: Step[]): { key: string; kind: 'add' | 'remove' | 'change' | 'same' }[] {
  const am = new Map(active.map((s) => [stepKey(s), s]));
  const dm = new Map(draft.map((s) => [stepKey(s), s]));
  const keys = Array.from(new Set([...am.keys(), ...dm.keys()])).sort();
  return keys.map((key) => {
    const a = am.get(key);
    const d = dm.get(key);
    if (a && !d) return { key, kind: 'remove' as const };
    if (!a && d) return { key, kind: 'add' as const };
    return { key, kind: JSON.stringify(a) === JSON.stringify(d) ? ('same' as const) : ('change' as const) };
  });
}

const DIFF_META: Record<string, { variant: 'success' | 'destructive' | 'warning' | 'chip'; sign: string }> = {
  add: { variant: 'success', sign: '+' },
  remove: { variant: 'destructive', sign: '−' },
  change: { variant: 'warning', sign: '~' },
  same: { variant: 'chip', sign: '=' },
};

export function WorkflowLineEditorSection({ projectId }: { projectId?: string | null }) {
  const t = useTranslations('settings');
  const [mode, setMode] = useState<Mode>('view');
  const [entityType, setEntityType] = useState<string>('story');
  const [versions, setVersions] = useState<VersionItem[]>([]);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [configText, setConfigText] = useState('');
  const [lint, setLint] = useState<{ status: string; errors: { message?: string }[] } | null>(null);
  const [activeSteps, setActiveSteps] = useState<Step[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadVersions = useCallback(async () => {
    const q = new URLSearchParams({ entity_type: entityType });
    if (projectId) q.set('project_id', projectId);
    const r = await fetch(`/api/workflow-line-config/versions?${q.toString()}`).catch(() => null);
    setVersions(r && r.ok ? (((await r.json()) as VersionItem[]) ?? []) : []);
  }, [entityType, projectId]);

  const loadActive = useCallback(async () => {
    const q = new URLSearchParams({ entity_type: entityType });
    if (projectId) q.set('project_id', projectId);
    const r = await fetch(`/api/workflow-line-config/active?${q.toString()}`).catch(() => null);
    const j = r && r.ok ? await r.json() : null;
    setActiveSteps((j?.config?.steps as Step[]) ?? []);
  }, [entityType, projectId]);

  useEffect(() => { void loadVersions(); void loadActive(); }, [loadVersions, loadActive]);

  const draftSteps = (() => {
    try { return (JSON.parse(configText) as { steps?: Step[] }).steps ?? []; } catch { return []; }
  })();

  const openVersion = async (id: string) => {
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/workflow-line-config/versions/${id}`);
      if (!r.ok) { setError(t('lineEditorLoadError')); return; }
      const v = (await r.json()) as VersionItem;
      setDraftId(id);
      setConfigText(JSON.stringify(v.config ?? { steps: [] }, null, 2));
      setLint(null);
      setMode('edit');
    } finally { setBusy(false); }
  };

  const newDraft = async () => {
    setBusy(true); setError(null);
    try {
      const r = await fetch('/api/workflow-line-config/versions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entity_type: entityType, project_id: projectId ?? null, config: { steps: activeSteps } }),
      });
      if (!r.ok) { setError(t('lineEditorCreateError')); return; }
      const v = (await r.json()) as VersionItem;
      await loadVersions();
      await openVersion(v.id);
    } finally { setBusy(false); }
  };

  const saveDraft = async () => {
    if (!draftId) return;
    let config: unknown;
    try { config = JSON.parse(configText); } catch { setError(t('lineEditorJsonError')); return; }
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/workflow-line-config/versions/${draftId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config }),
      });
      if (!r.ok) { setError(t('lineEditorSaveError')); return; }
      await loadVersions();
    } finally { setBusy(false); }
  };

  const runLint = async () => {
    if (!draftId) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/workflow-line-config/versions/${draftId}/lint`, { method: 'POST' });
      setLint(r.ok ? ((await r.json()) as { status: string; errors: { message?: string }[] }) : null);
    } finally { setBusy(false); }
  };

  const requestPublish = async () => {
    if (!draftId) return;
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/workflow-line-config/versions/${draftId}/request-publish`, { method: 'POST' });
      if (!r.ok) { setError(t('lineEditorPublishError')); return; }
      await loadVersions();
    } finally { setBusy(false); }
  };

  const inputCls = 'h-9 rounded-md border border-border bg-background px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40';
  const diff = diffSteps(activeSteps, draftSteps);

  return (
    <div className="space-y-4">
      {/* 모드 스위처 + entity_type */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-lg border border-border bg-muted/30 p-0.5">
          {MODES.map(({ key, labelKey, Icon }) => (
            <button
              key={key}
              type="button"
              onClick={() => setMode(key)}
              className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${mode === key ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
            >
              <Icon className="size-3.5" />
              {t(labelKey)}
            </button>
          ))}
        </div>
        <select value={entityType} onChange={(e) => setEntityType(e.target.value)} className={`${inputCls} ml-auto`}>
          {ENTITY_TYPES.map((et) => <option key={et} value={et}>{et}</option>)}
        </select>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {/* VIEW: S29 active + simulator 재사용 */}
      {mode === 'view' ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <WorkflowActiveLineView projectId={projectId} />
          <WorkflowPolicySimulatorSection />
        </div>
      ) : null}

      {/* EDIT: config JSON 편집 + lint + 저장 + publish 요청 */}
      {mode === 'edit' ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="ghost" className="gap-1" disabled={busy} onClick={() => void newDraft()}>
              <Plus className="size-3.5" />{t('lineEditorNewDraft')}
            </Button>
            {draftId ? (
              <>
                <Button size="sm" variant="ghost" className="gap-1" disabled={busy} onClick={() => void runLint()}>
                  <FileCheck2 className="size-3.5" />{t('lineEditorLint')}
                </Button>
                <Button size="sm" variant="ghost" className="gap-1 text-primary hover:bg-primary/10 hover:text-primary" disabled={busy} onClick={() => void saveDraft()}>
                  <Save className="size-3.5" />{t('lineEditorSave')}
                </Button>
                <Button size="sm" variant="ghost" className="gap-1 text-success hover:bg-success-tint hover:text-success" disabled={busy} onClick={() => void requestPublish()}>
                  <Send className="size-3.5" />{t('lineEditorRequestPublish')}
                </Button>
              </>
            ) : null}
          </div>
          {draftId ? (
            <>
              <textarea
                rows={12}
                value={configText}
                onChange={(e) => setConfigText(e.target.value)}
                spellCheck={false}
                className="w-full resize-y rounded-xl border border-border bg-background px-3 py-2 font-mono text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
              {lint ? (
                <div className="space-y-1">
                  <Badge variant={lint.status === 'passed' ? 'success' : 'destructive'}>
                    {lint.status === 'passed' ? t('lineEditorLintPass') : t('lineEditorLintFail')}
                  </Badge>
                  {lint.errors?.length ? (
                    <ul className="space-y-0.5">
                      {lint.errors.map((e, i) => <li key={i} className="text-[11px] text-destructive">{e.message ?? JSON.stringify(e)}</li>)}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : (
            <p className="text-xs text-muted-foreground">{t('lineEditorNoDraft')}</p>
          )}
        </div>
      ) : null}

      {/* HISTORY: 버전 리스트 + 5상태 배지 */}
      {mode === 'history' ? (
        versions.length ? (
          <ul className="space-y-1.5">
            {versions.map((v) => (
              <li key={v.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card px-3 py-2">
                <span className="font-mono text-xs text-foreground">v{v.version}</span>
                <Badge variant={STATUS_VARIANT[v.status] ?? 'chip'}>{v.status}</Badge>
                <span className="text-[10px] text-muted-foreground">{t('lineEditorLintLabel')}: {v.lint_status}</span>
                {v.updated_at ? <span className="text-[10px] text-muted-foreground/70">{new Date(v.updated_at).toLocaleString()}</span> : null}
                {v.status === 'draft' ? (
                  <Button size="sm" variant="ghost" className="ml-auto h-7 gap-1" onClick={() => void openVersion(v.id)}>
                    <Pencil className="size-3.5" />{t('lineEditorEditAction')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : <p className="text-xs text-muted-foreground">{t('lineEditorNoVersions')}</p>
      ) : null}

      {/* DIFF: ⭐ FE 클라 계산(active vs 편집 中 draft) path별 add/change/remove */}
      {mode === 'diff' ? (
        <div className="space-y-2">
          <p className="text-[11px] text-muted-foreground">{t('lineEditorDiffHint')}</p>
          {diff.length ? (
            <ul className="space-y-0.5">
              {diff.map(({ key, kind }) => {
                const m = DIFF_META[kind]!;
                return (
                  <li key={key} className="flex items-center gap-2 text-xs">
                    <Badge variant={m.variant} className="w-5 justify-center font-mono">{m.sign}</Badge>
                    <span className={`font-mono ${kind === 'remove' ? 'text-muted-foreground line-through' : 'text-foreground'}`}>{key}</span>
                  </li>
                );
              })}
            </ul>
          ) : <p className="text-xs text-muted-foreground">{t('lineEditorDiffEmpty')}</p>}
        </div>
      ) : null}
    </div>
  );
}
