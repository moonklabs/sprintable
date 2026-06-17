'use client';

import { useEffect, useState } from 'react';
import { Lock } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { cn } from '@/lib/utils';

/**
 * HITL 게이트 레벨 매트릭스 (S-GATE-4). (work_type done·merge) × (actor agent·human) → level
 * (auto·ask·block) 를 설정. 레벨 컬러/마크는 `components/cage/gate-evidence` DECISION_META 와
 * **verbatim 미러**(설정한 것 = 인박스에서 보는 것).
 *
 * v1(이 PR): effective 레벨 표시 + 셀 즉시 PUT(낙관적·실패 롤백). 2계층 상속/재정의 시각·↺복귀는
 * BE(org-layer GET·셀별 source·override DELETE) 랜딩 후 와이어 — 컴포넌트는 그때 source-aware 확장.
 * 안전 하한(merge≥ask·self-approval 차단)은 BE(S-GATE-3) 강제 — UI 는 floor 를 **표현만**(우회 금지).
 */

type Level = 'auto' | 'ask' | 'block';
type WorkType = 'done' | 'merge';
type ActorType = 'agent' | 'human';

interface GateLevelEntry { work_type: string; actor_type: string; level: string }

const WORK_TYPES: WorkType[] = ['done', 'merge'];
const ACTOR_TYPES: ActorType[] = ['agent', 'human'];
const LEVELS: Level[] = ['auto', 'ask', 'block'];

// GateEvidence DECISION_META 미러: auto→success ✓ / ask→warning ⏸ / block→destructive ⛔.
const LEVEL_META: Record<Level, { selected: string; badge: 'success' | 'warning' | 'destructive'; mark: string; labelKey: string }> = {
  auto: { selected: 'border-success-border bg-success-tint text-success', badge: 'success', mark: '✓', labelKey: 'levelAuto' },
  ask: { selected: 'border-warning-border bg-warning-tint text-warning', badge: 'warning', mark: '⏸', labelKey: 'levelAsk' },
  block: { selected: 'border-destructive/40 bg-destructive/10 text-destructive', badge: 'destructive', mark: '⛔', labelKey: 'levelBlock' },
};

// 안전 하한(S-GATE-3 BE 강제): merge 는 최소 'ask' — 'auto' 비활성(UI 표현만, BE 가 우회 차단).
const isLevelDisabled = (workType: WorkType, level: Level): boolean => workType === 'merge' && level === 'auto';

const cellKey = (w: string, a: string) => `${w}:${a}`;

interface GateLevelMatrixProps {
  projectId: string;
  scope: 'org' | 'project';
  canEdit: boolean;
}

export function GateLevelMatrix({ projectId, scope, canEdit }: GateLevelMatrixProps) {
  const t = useTranslations('gateConfig');
  const [levels, setLevels] = useState<Record<string, Level>>({});
  const [loading, setLoading] = useState(true);
  const [savingCell, setSavingCell] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      const res = await fetch(`/api/projects/${projectId}/gate-config`).catch(() => null);
      if (cancelled) return;
      if (res?.ok) {
        const json = await res.json() as { data?: GateLevelEntry[] };
        const map: Record<string, Level> = {};
        for (const e of json.data ?? []) {
          if ((LEVELS as string[]).includes(e.level)) map[cellKey(e.work_type, e.actor_type)] = e.level as Level;
        }
        setLevels(map);
      }
      setLoading(false);
    }
    void load();
    return () => { cancelled = true; };
  }, [projectId]);

  const handleSet = async (workType: WorkType, actorType: ActorType, level: Level) => {
    if (!canEdit || isLevelDisabled(workType, level) || savingCell) return;
    const key = cellKey(workType, actorType);
    if (levels[key] === level) return;
    const prev = levels[key];
    setSavingCell(key);
    setMessage(null);
    setLevels((m) => ({ ...m, [key]: level })); // 낙관적(assignee #1539 패턴)
    try {
      const res = await fetch(`/api/projects/${projectId}/gate-config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, work_type: workType, actor_type: actorType, level }),
      });
      if (res.ok) {
        const json = await res.json().catch(() => null) as { data?: GateLevelEntry } | null;
        const applied = json?.data?.level;
        if (applied && (LEVELS as string[]).includes(applied)) setLevels((m) => ({ ...m, [key]: applied as Level }));
        setMessage({ type: 'success', text: t('saved') });
      } else {
        setLevels((m) => (prev ? { ...m, [key]: prev } : (() => { const n = { ...m }; delete n[key]; return n; })()));
        setMessage({ type: 'error', text: t('saveFailed') });
      }
    } catch {
      setLevels((m) => (prev ? { ...m, [key]: prev } : (() => { const n = { ...m }; delete n[key]; return n; })()));
      setMessage({ type: 'error', text: t('saveFailed') });
    } finally {
      setSavingCell(null);
    }
  };

  return (
    <SectionCard>
      <SectionCardHeader>
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-foreground">{t('title')}</h2>
          <p className="text-sm text-muted-foreground">{t('description')}</p>
        </div>
      </SectionCardHeader>
      <SectionCardBody className="space-y-4">
        {message && (
          <Alert variant={message.type === 'success' ? 'success' : 'destructive'}>
            <AlertDescription>{message.text}</AlertDescription>
          </Alert>
        )}

        {/* 레전드 */}
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
                  const current = levels[key];
                  const saving = savingCell === key;
                  return (
                    <div key={at} className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm">
                      <span className="font-medium text-foreground">{t(`actor_${at}`)}</span>
                      {canEdit ? (
                        <div className="flex shrink-0 gap-1" role="group" aria-label={t(`actor_${at}`)}>
                          {LEVELS.map((lv) => {
                            const selected = current === lv;
                            const floorDisabled = isLevelDisabled(wt, lv);
                            return (
                              <Button
                                key={lv}
                                type="button"
                                variant="glass"
                                size="sm"
                                disabled={floorDisabled || saving}
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
                      ) : current ? (
                        <Badge variant={LEVEL_META[current].badge} className="shrink-0">
                          <span aria-hidden className="mr-0.5">{LEVEL_META[current].mark}</span>
                          {t(LEVEL_META[current].labelKey)}
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
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
