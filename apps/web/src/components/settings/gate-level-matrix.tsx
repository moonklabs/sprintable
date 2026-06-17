'use client';

import { useEffect, useState } from 'react';
import { Lock, RotateCcw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { cn } from '@/lib/utils';

/**
 * HITL 게이트 레벨 매트릭스 (S-GATE-4). (work_type done·merge) × (actor agent·human) → level
 * (auto·ask·block). 레벨 컬러/마크는 `components/cage/gate-evidence` DECISION_META **verbatim 미러**.
 *
 * 2계층(S-GATE-4 BE #1565): 셀별 `source`(org_default=상속 / override=재정의).
 * - project surface: GET `/projects/{id}/gate-config`(effective+source). 설정=PUT scope='project'(override),
 *   ↺ 복귀=DELETE(override 해제→상속). 상속=muted "상속" 태그 / 재정의=강조 태그 + ↺.
 * - org surface: GET `/organizations/{org_id}/gate-config`(org 기본값 단독). 설정=PUT scope='org'(대표
 *   project 경유). override 개념 없음 → source 태그 없음.
 *
 * 안전 하한(S-GATE-3 BE 강제): merge≥ask — auto 비활성(UI 표현만·BE 가 우회 차단).
 */

type Level = 'auto' | 'ask' | 'block';
type WorkType = 'done' | 'merge';
type ActorType = 'agent' | 'human';
type Source = 'org_default' | 'override';

interface GateLevelEntry { work_type: string; actor_type: string; level: string; source?: string }
interface GateCell { level: Level; source: Source }

const WORK_TYPES: WorkType[] = ['done', 'merge'];
const ACTOR_TYPES: ActorType[] = ['agent', 'human'];
const LEVELS: Level[] = ['auto', 'ask', 'block'];

// GateEvidence DECISION_META 미러: auto→success ✓ / ask→warning ⏸ / block→destructive ⛔.
const LEVEL_META: Record<Level, { selected: string; badge: 'success' | 'warning' | 'destructive'; mark: string; labelKey: string }> = {
  auto: { selected: 'border-success-border bg-success-tint text-success', badge: 'success', mark: '✓', labelKey: 'levelAuto' },
  ask: { selected: 'border-warning-border bg-warning-tint text-warning', badge: 'warning', mark: '⏸', labelKey: 'levelAsk' },
  block: { selected: 'border-destructive-border bg-destructive-tint text-destructive', badge: 'destructive', mark: '⛔', labelKey: 'levelBlock' },
};

// 안전 하한(S-GATE-3 BE 강제): merge 는 최소 'ask' — 'auto' 비활성(UI 표현만, BE 가 우회 차단).
const isLevelDisabled = (workType: WorkType, level: Level): boolean => workType === 'merge' && level === 'auto';

const cellKey = (w: string, a: string) => `${w}:${a}`;
const toSource = (s?: string): Source => (s === 'override' ? 'override' : 'org_default');

interface GateLevelMatrixProps {
  surface: 'org' | 'project';
  /** project surface: 대상 project. org surface: PUT scope='org' 경유용 대표 project(없으면 편집 불가). */
  projectId?: string;
  /** org surface: org 기본값 GET 경로. */
  orgId?: string;
  canEdit: boolean;
}

export function GateLevelMatrix({ surface, projectId, orgId, canEdit }: GateLevelMatrixProps) {
  const t = useTranslations('gateConfig');
  const [cells, setCells] = useState<Record<string, GateCell>>({});
  const [loading, setLoading] = useState(true);
  const [busyCell, setBusyCell] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // org 기본값 설정도 project 라우트(scope='org')를 경유하므로 대표 projectId 가 있어야 쓰기 가능.
  const canWrite = canEdit && !!projectId;
  const getUrl = surface === 'org'
    ? (orgId ? `/api/organizations/${orgId}/gate-config` : null)
    : (projectId ? `/api/projects/${projectId}/gate-config` : null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!getUrl) { setLoading(false); return; }
      setLoading(true);
      const res = await fetch(getUrl).catch(() => null);
      if (cancelled) return;
      if (res?.ok) {
        const json = await res.json() as { data?: GateLevelEntry[] };
        const map: Record<string, GateCell> = {};
        for (const e of json.data ?? []) {
          if ((LEVELS as string[]).includes(e.level)) map[cellKey(e.work_type, e.actor_type)] = { level: e.level as Level, source: toSource(e.source) };
        }
        setCells(map);
      }
      setLoading(false);
    }
    void load();
    return () => { cancelled = true; };
  }, [getUrl]);

  const applyEntry = (key: string, e?: GateLevelEntry | null) => {
    if (e && (LEVELS as string[]).includes(e.level)) setCells((m) => ({ ...m, [key]: { level: e.level as Level, source: toSource(e.source) } }));
  };
  const rollback = (key: string, prev?: GateCell) =>
    setCells((m) => (prev ? { ...m, [key]: prev } : (() => { const n = { ...m }; delete n[key]; return n; })()));

  const handleSet = async (wt: WorkType, at: ActorType, level: Level) => {
    if (!canWrite || !projectId || isLevelDisabled(wt, level) || busyCell) return;
    const key = cellKey(wt, at);
    // org surface: 같은 레벨 noop. project surface: 같은 레벨이라도 상속이면 override 생성 의미 있음.
    if (cells[key]?.level === level && (surface === 'org' || cells[key]?.source === 'override')) return;
    const prev = cells[key];
    setBusyCell(key);
    setMessage(null);
    setCells((m) => ({ ...m, [key]: { level, source: surface === 'org' ? 'org_default' : 'override' } })); // 낙관적(#1539)
    try {
      const res = await fetch(`/api/projects/${projectId}/gate-config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: surface === 'org' ? 'org' : 'project', work_type: wt, actor_type: at, level }),
      });
      if (res.ok) {
        applyEntry(key, (await res.json().catch(() => null) as { data?: GateLevelEntry } | null)?.data);
        setMessage({ type: 'success', text: t('saved') });
      } else {
        rollback(key, prev);
        setMessage({ type: 'error', text: t('saveFailed') });
      }
    } catch {
      rollback(key, prev);
      setMessage({ type: 'error', text: t('saveFailed') });
    } finally {
      setBusyCell(null);
    }
  };

  const handleRevert = async (wt: WorkType, at: ActorType) => {
    if (!canWrite || !projectId || busyCell) return;
    const key = cellKey(wt, at);
    const prev = cells[key]; // override 스냅샷
    setBusyCell(key);
    setMessage(null);
    // 낙관적(PUT 미러): source 를 즉시 org_default 로(재정의 배지·↺ 즉시 사라짐). 상속 레벨은 응답이 확정.
    setCells((m) => (prev ? { ...m, [key]: { ...prev, source: 'org_default' } } : m));
    try {
      const res = await fetch(`/api/projects/${projectId}/gate-config?work_type=${wt}&actor_type=${at}`, { method: 'DELETE' });
      if (res.ok) {
        applyEntry(key, (await res.json().catch(() => null) as { data?: GateLevelEntry } | null)?.data);
        setMessage({ type: 'success', text: t('reverted') });
      } else {
        rollback(key, prev); // 실패 → override 복원
        setMessage({ type: 'error', text: t('saveFailed') });
      }
    } catch {
      rollback(key, prev);
      setMessage({ type: 'error', text: t('saveFailed') });
    } finally {
      setBusyCell(null);
    }
  };

  return (
    <SectionCard>
      <SectionCardHeader>
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-foreground">{surface === 'org' ? t('titleOrg') : t('title')}</h2>
          <p className="text-sm text-muted-foreground">{surface === 'org' ? t('descriptionOrg') : t('description')}</p>
        </div>
      </SectionCardHeader>
      <SectionCardBody className="space-y-4">
        {message && (
          <Alert variant={message.type === 'success' ? 'success' : 'destructive'}>
            <AlertDescription>{message.text}</AlertDescription>
          </Alert>
        )}
        {canEdit && !projectId ? (
          <Alert variant="default">
            <AlertDescription>{t('noProjectForOrgEdit')}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          {LEVELS.map((lv) => (
            <span key={lv} className="inline-flex items-center gap-1">
              <span aria-hidden>{LEVEL_META[lv].mark}</span>{t(LEVEL_META[lv].labelKey)}
            </span>
          ))}
        </div>

        {loading ? (
          <div className="space-y-1 divide-y divide-border">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="flex items-center justify-between gap-3 px-3 py-3">
                <div className="h-4 w-20 animate-pulse rounded bg-muted" />
                <div className="h-7 w-48 animate-pulse rounded bg-muted" />
              </div>
            ))}
          </div>
        ) : (
          WORK_TYPES.map((wt) => (
            <div key={wt} className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-semibold text-foreground">{t(`work_${wt}`)}</p>
                {wt === 'merge' ? (
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <Lock className="h-3 w-3" />
                    {t('mergeFloorNote')}
                  </span>
                ) : null}
              </div>
              <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
                {ACTOR_TYPES.map((at) => {
                  const key = cellKey(wt, at);
                  const cell = cells[key];
                  const busy = busyCell === key;
                  const isOverride = surface === 'project' && cell?.source === 'override';
                  return (
                    <div key={at} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3 py-2.5 text-sm">
                      <span className="font-medium text-foreground">{t(`actor_${at}`)}</span>
                      <div className="flex shrink-0 items-center gap-2">
                        {/* project surface: 상속/재정의 source 표시(+ override 면 ↺ 복귀). org surface: 없음. */}
                        {surface === 'project' && cell ? (
                          isOverride ? (
                            <span className="inline-flex items-center gap-1">
                              <Badge variant="outline" className="border-primary/40 text-primary">{t('sourceOverride')}</Badge>
                              {canWrite ? (
                                <button
                                  type="button"
                                  onClick={() => void handleRevert(wt, at)}
                                  disabled={busy}
                                  title={t('revertToDefault')}
                                  aria-label={t('revertToDefault')}
                                  className="inline-flex items-center text-muted-foreground hover:text-foreground disabled:opacity-50"
                                >
                                  <RotateCcw className="h-3.5 w-3.5" />
                                </button>
                              ) : null}
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">{t('sourceInherited')}</span>
                          )
                        ) : null}
                        {canWrite ? (
                          <div className="flex gap-1" role="group" aria-label={t(`actor_${at}`)}>
                            {LEVELS.map((lv) => {
                              const selected = cell?.level === lv;
                              const floorDisabled = isLevelDisabled(wt, lv);
                              return (
                                <Button
                                  key={lv}
                                  type="button"
                                  variant="glass"
                                  size="sm"
                                  disabled={floorDisabled || busy}
                                  title={floorDisabled ? t('floorDisabledHint') : undefined}
                                  onClick={() => void handleSet(wt, at, lv)}
                                  className={cn(
                                    'min-w-[60px] gap-1 transition-colors',
                                    selected ? LEVEL_META[lv].selected : 'border-border text-muted-foreground hover:bg-muted/40',
                                    floorDisabled && 'opacity-40',
                                  )}
                                >
                                  <span aria-hidden>{LEVEL_META[lv].mark}</span>{t(LEVEL_META[lv].labelKey)}
                                </Button>
                              );
                            })}
                          </div>
                        ) : cell ? (
                          <Badge variant={LEVEL_META[cell.level].badge} className="shrink-0">
                            <span aria-hidden className="mr-0.5">{LEVEL_META[cell.level].mark}</span>
                            {t(LEVEL_META[cell.level].labelKey)}
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </SectionCardBody>
    </SectionCard>
  );
}
