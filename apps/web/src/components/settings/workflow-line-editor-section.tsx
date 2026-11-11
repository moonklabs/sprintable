'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Eye, Pencil, History, GitCompare, Plus, FileCheck2, Send, Save } from 'lucide-react';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { Field } from '@/components/ds/field';
import { Textarea } from '@/components/ds/input';
import { NativeSelect } from '@/components/ds/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ds/tabs';
import { Tag } from './settings-parts';
import { WorkflowActiveLineView } from './workflow-active-line-view';
import { WorkflowPolicySimulatorSection } from './workflow-policy-simulator-section';
import { useRenderNonce } from '@/hooks/use-render-nonce';

import { fetchWithAuth } from '@/lib/db/client';
import { formatViewerRelativeTime } from '@/lib/storage/format';
import { useViewerTimeZone } from '@/components/viewer-time-zone';

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

// 5상태 꼬리표(version.status). publish 거버넌스 lifecycle — ds 뜻 색(끝남 · 손 필요 · 실패)만 입고, 그 밖은 중립.
const STATUS_TONE: Record<string, 'done' | 'needs-hand' | 'failed' | 'neutral'> = {
  published: 'done',
  draft: 'neutral',
  pending_publish: 'needs-hand',
  rejected: 'failed',
  retired: 'neutral',
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

const DIFF_META: Record<string, { tone: 'done' | 'failed' | 'needs-hand' | 'neutral'; sign: string }> = {
  add: { tone: 'done', sign: '+' },
  remove: { tone: 'failed', sign: '−' },
  change: { tone: 'needs-hand', sign: '~' },
  same: { tone: 'neutral', sign: '=' },
};

export function WorkflowLineEditorSection({ projectId }: { projectId?: string | null }) {
  const t = useTranslations('settings');
  const locale = useLocale();
  const displayTimezone = useViewerTimeZone(); // story #4443 PR2b — the viewer's zone (null until known)
  const [mode, setMode] = useState<Mode>('view');
  const [entityType, setEntityType] = useState<string>('story');
  const [versions, setVersions] = useState<VersionItem[]>([]);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [configText, setConfigText] = useState('');
  const [lint, setLint] = useState<{ lint_status: string; errors: { message?: string }[] } | null>(null);
  const [activeSteps, setActiveSteps] = useState<Step[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // story #2154 — saveDraft의 JSON 파싱 실패 catch가 그 함수 자신의 setError(null)
  // 리셋보다 먼저 return해, 연속 동일 실패 시 재낭독이 안 될 수 있던 것을 nonce-key로
  // 구조적으로 막는다(같은 error state를 쓰는 다른 핸들러도 함께 통일).
  const [errorNonce, bumpErrorNonce] = useRenderNonce();

  const loadVersions = useCallback(async () => {
    const q = new URLSearchParams({ entity_type: entityType });
    if (projectId) q.set('project_id', projectId);
    const r = await fetchWithAuth(`/api/workflow-line-config/versions?${q.toString()}`).catch(() => null);
    setVersions(r && r.ok ? (((await r.json()) as VersionItem[]) ?? []) : []);
  }, [entityType, projectId]);

  const loadActive = useCallback(async () => {
    const q = new URLSearchParams({ entity_type: entityType });
    if (projectId) q.set('project_id', projectId);
    const r = await fetchWithAuth(`/api/workflow-line-config/active?${q.toString()}`).catch(() => null);
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
      if (!r.ok) { bumpErrorNonce(); setError(t('lineEditorLoadError')); return; }
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
      if (!r.ok) { bumpErrorNonce(); setError(t('lineEditorCreateError')); return; }
      const v = (await r.json()) as VersionItem;
      await loadVersions();
      await openVersion(v.id);
    } finally { setBusy(false); }
  };

  const saveDraft = async () => {
    if (!draftId) return;
    let config: unknown;
    try { config = JSON.parse(configText); } catch { bumpErrorNonce(); setError(t('lineEditorJsonError')); return; }
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/workflow-line-config/versions/${draftId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config }),
      });
      if (!r.ok) { bumpErrorNonce(); setError(t('lineEditorSaveError')); return; }
      await loadVersions();
    } finally { setBusy(false); }
  };

  const runLint = async () => {
    if (!draftId) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/workflow-line-config/versions/${draftId}/lint`, { method: 'POST' });
      setLint(r.ok ? ((await r.json()) as { lint_status: string; errors: { message?: string }[] }) : null);
    } finally { setBusy(false); }
  };

  const requestPublish = async () => {
    if (!draftId) return;
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/workflow-line-config/versions/${draftId}/request-publish`, { method: 'POST' });
      if (!r.ok) { bumpErrorNonce(); setError(t('lineEditorPublishError')); return; }
      await loadVersions();
    } finally { setBusy(false); }
  };

  const diff = diffSteps(activeSteps, draftSteps);

  return (
    <div className="space-y-4">
      {/* 모드 스위처(같은 화면 안에서 칸을 갈아 보이는 탭) + entity_type */}
      <Tabs value={mode} onValueChange={(next) => setMode(next as Mode)} className="gap-4">
        <TabsList aria-label={t('tabWorkflowPolicies')}>
          {MODES.map(({ key, labelKey, Icon }) => (
            <TabsTrigger key={key} value={key}>
              <Icon className="size-3.5" aria-hidden />
              {t(labelKey)}
            </TabsTrigger>
          ))}
        </TabsList>

        <Field label={t('simEntityType')} className="sm:max-w-xs">
          {(c) => (
            <NativeSelect {...c} value={entityType} onChange={(e) => setEntityType(e.target.value)}>
              {ENTITY_TYPES.map((et) => <option key={et} value={et}>{et}</option>)}
            </NativeSelect>
          )}
        </Field>

        {/* story #2154 — the nonce key remounts the line on every failure, so the same failure twice in a row is read out twice (the ds failed Banner is an alert) */}
        {error ? <Banner key={errorNonce} tone="failed">{error}</Banner> : null}

        {/* VIEW: S29 active + simulator 재사용 */}
        <TabsContent value="view">
          <div className="grid gap-4 lg:grid-cols-2">
            <WorkflowActiveLineView projectId={projectId} />
            <WorkflowPolicySimulatorSection />
          </div>
        </TabsContent>

        {/* EDIT: config JSON 편집 + lint + 저장 + publish 요청 */}
        <TabsContent value="edit">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="secondary" disabled={busy} iconStart={<Plus className="size-3.5" aria-hidden />} onClick={() => void newDraft()}>
                {t('lineEditorNewDraft')}
              </Button>
              {draftId ? (
                <>
                  <Button type="button" variant="secondary" disabled={busy} iconStart={<FileCheck2 className="size-3.5" aria-hidden />} onClick={() => void runLint()}>
                    {t('lineEditorLint')}
                  </Button>
                  <Button type="button" variant="primary" disabled={busy} iconStart={<Save className="size-3.5" aria-hidden />} onClick={() => void saveDraft()}>
                    {t('lineEditorSave')}
                  </Button>
                  <Button type="button" variant="secondary" disabled={busy} iconStart={<Send className="size-3.5" aria-hidden />} onClick={() => void requestPublish()}>
                    {t('lineEditorRequestPublish')}
                  </Button>
                </>
              ) : null}
            </div>
            {draftId ? (
              <>
                <Textarea
                  rows={12}
                  aria-label={t('lineModeEdit')}
                  value={configText}
                  onChange={(e) => setConfigText(e.target.value)}
                  spellCheck={false}
                  className="font-mono"
                />
                {lint ? (
                  <div className="space-y-1">
                    <Tag tone={lint.lint_status === 'passed' ? 'done' : 'failed'}>
                      {lint.lint_status === 'passed' ? t('lineEditorLintPass') : t('lineEditorLintFail')}
                    </Tag>
                    {lint.errors?.length ? (
                      <ul className="space-y-0.5">
                        {lint.errors.map((e, i) => <li key={i} className="text-ds-small text-ds-failed">{e.message ?? JSON.stringify(e)}</li>)}
                      </ul>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : (
              <p className="text-ds-small text-ds-ink-3">{t('lineEditorNoDraft')}</p>
            )}
          </div>
        </TabsContent>

        {/* HISTORY: 버전 리스트 + 5상태 꼬리표 */}
        <TabsContent value="history">
          {versions.length ? (
            <ul className="divide-y divide-ds-line overflow-hidden rounded-ds-control border border-ds-line">
              {versions.map((v, index) => (
                <li key={v.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2">
                  <span className="font-mono text-ds-small text-ds-ink">v{v.version}</span>
                  <Tag tone={STATUS_TONE[v.status] ?? 'neutral'}>{v.status}</Tag>
                  <span className="text-ds-small text-ds-ink-3">{t('lineEditorLintLabel')}: {v.lint_status}</span>
                  {v.updated_at ? <span className="text-ds-small text-ds-ink-3">{formatViewerRelativeTime(v.updated_at, locale, displayTimezone)}</span> : null}
                  {/* story #3592(§17-20 ⑧·§22-18 동형) — 행마다 같은 「편집」 접근 이름이라 보조기술 버튼 목록에서 어느 버전 행인지 못 가른다. */}
                  {v.status === 'draft' ? (
                    <Button
                      type="button" variant="quiet" className="ml-auto" onClick={() => void openVersion(v.id)}
                      aria-label={t('lineEditorEditAriaLabel', { n: index + 1, label: t('lineEditorEditAction') })}
                      iconStart={<Pencil className="size-3.5" aria-hidden />}
                    >
                      {t('lineEditorEditAction')}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : <p className="text-ds-small text-ds-ink-3">{t('lineEditorNoVersions')}</p>}
        </TabsContent>

        {/* DIFF: ⭐ FE 클라 계산(active vs 편집 中 draft) path별 add/change/remove */}
        <TabsContent value="diff">
          <div className="space-y-2">
            <p className="text-ds-small text-ds-ink-3">{t('lineEditorDiffHint')}</p>
            {diff.length ? (
              <ul className="space-y-1">
                {diff.map(({ key, kind }) => {
                  const m = DIFF_META[kind]!;
                  return (
                    <li key={key} className="flex items-center gap-2 text-ds-small">
                      <Tag tone={m.tone} className="w-6 justify-center font-mono">{m.sign}</Tag>
                      <span className={`font-mono ${kind === 'remove' ? 'text-ds-ink-3 line-through' : 'text-ds-ink'}`}>{key}</span>
                    </li>
                  );
                })}
              </ul>
            ) : <p className="text-ds-small text-ds-ink-3">{t('lineEditorDiffEmpty')}</p>}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
