'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations, useLocale } from 'next-intl';
import { ChevronLeft, GripVertical, Plus, Send, Trash2, X, Flag } from 'lucide-react';
import { DndContext, type DragEndEvent, PointerSensor, useSensor, useSensors, closestCenter } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { computeReorderPatch } from '@/lib/epic-steer';
import { useOrgSyncVersion } from '@/lib/project-context-client';
import { useGoalsRoute } from './goals-context';
import { Button } from '@/components/ui/button';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { Badge } from '@/components/ui/badge';
import { MaterialChip } from '@/components/ui/material-chip';
import { EmptyState } from '@/components/ui/empty-state';

// story 3995840c(doc resource-view-firsttouch-identity-pattern §4 "에픽" 행 — 정체성=하나의 큰
// 목표·여러 스토리가 성과로·visual=선택 그룹hint): 작은 점 3개가 큰 원 하나로 모이는 형태 —
// 실험실(4노드 원형 사이클)·현황판(3-waypoint 직선)·스프린트(기간bar)와 differentiate. 과설명
// 금지 — 점+원뿐, 라벨 없음(그룹핑 자체가 메시지).
function GoalGroupHint() {
  return (
    <svg viewBox="0 0 48 24" className="size-6 w-12 text-muted-foreground" aria-hidden="true">
      <circle cx="10" cy="8" r="2" fill="currentColor" opacity="0.5" />
      <circle cx="10" cy="16" r="2" fill="currentColor" opacity="0.5" />
      <circle cx="4" cy="12" r="2" fill="currentColor" opacity="0.5" />
      <circle cx="34" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
import {
  Dialog, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { ToastContainer, useToast } from '@/components/ui/toast';
import { OutcomeStatusBadge } from '@/components/outcome/outcome-status-badge';
import { HypothesesSummary } from '@/components/hypotheses/hypotheses-summary';
import { EpicHypothesisDeclarationSection } from '@/components/epics/hypothesis-declaration-section';
import type { HypothesisDeclarationValue } from '@/services/hypothesis-declaration';
import { toEpicHypothesisCreatePayload, toEpicHypothesisLink } from '@/services/hypothesis-declaration-epic';
import { SteerDispatchModal } from './steer-dispatch-modal';
import { HumanOnlyAction } from '@/components/ui/human-only-action';

import { fetchWithAuth } from '@/lib/db/client';

// ─── Drag sensor ──────────────────────────────────────────────────────────────

/**
 * 좌클릭(button===0)·비터치만 드래그 — 터치는 네이티브 스크롤(kanban-board.tsx 0d142311 RC와
 * 동형·산티아고 QA 확定). 로드맵 조타 리스트도 터치 no-drag 가디언 락을 이 센서로 충족한다.
 */
class MousePointerSensor extends PointerSensor {
  static activators = [
    {
      eventName: 'onPointerDown' as const,
      handler: ({ nativeEvent }: { nativeEvent: PointerEvent }) =>
        nativeEvent.isPrimary && nativeEvent.button === 0 && nativeEvent.pointerType !== 'touch',
    },
  ];
}

/** 조타 모드 전량 로드 상한(BE/route maxLimit=100). 초과분은 honest 표시(silent-truncation 금지). */
const STEER_LIMIT = 100;

// ─── Types ────────────────────────────────────────────────────────────────────

type GoalStatus = 'draft' | 'active' | 'done' | 'archived';
type GoalPriority = 'critical' | 'high' | 'medium' | 'low';

interface Story {
  id: string;
  title: string;
  status: string;
  story_points?: number;
}

interface Goal {
  id: string;
  title: string;
  description?: string;
  status: GoalStatus;
  priority: GoalPriority;
  target_date?: string;
  target_sp?: number;
  created_at: string;
  stories?: Story[];
  success_hypothesis?: string | null;
  metric_definition?: Record<string, unknown> | null;
  measure_after?: string | null;
  // story #2958 — outcome-status-badge.tsx는 이미 unmeasured/unmeasurable을 지원했으나 이 타입엔
  // 없었다(타입 갭, 실 BE 값은 이미 이 4종 전부 낼 수 있음).
  outcome_status?: 'n_a' | 'pending' | 'hit' | 'miss' | 'unmeasured' | 'unmeasurable' | null;
  outcome_result?: Record<string, unknown> | null;
  // E1 S8b: BE EpicResponse가 list 응답에 부착하는 연결 가설 집계(미부착 경로는 기본값).
  hypothesis_count?: number;
  risky_status?: string | null;
  // 0d4c89e8: BE list 응답 story count 집계(#1527). detail/미부착 경로는 stories 폴백.
  total_stories?: number;
  done_stories?: number;
  // wedge #2(로드맵 조타·BE #2076): 큐레이션 순서(null=미조타·자동도출). source_loop_id는 Loop
  // 제안 hook — 실 배선 P3/v2, v1은 미표시(no-fiction).
  position?: number | null;
  source_loop_id?: string | null;
  // story #3126(#2341 AC1 후속) — `?include=glance` 옵트인 시에만 실린다. 이 goal 소속
  // non-done story의 updated_at 최댓값(없으면 null) — "status='active' 52개 중 몇 개가
  // «정말» 움직이는가"를 이 필드+dormancy_threshold_hours로 가른다("active" 미포함 이름).
  latest_story_activity_at?: string | null;
}

// story #3126 — epics-progress-lane fetch가 실패했을 때만 쓰는 폴백(옛 코드가 이 신호 자체가
// 없던 시절과 동일하게 «전부 active로 인정»하지 않기 위한 최소값이 아니라, next-maker-screen.tsx
// 의 동일 상수와 정합해 같은 실패-시나리오에서 같은 값을 쓴다).
const DEFAULT_DORMANCY_THRESHOLD_HOURS = 720;

// story #3126 — Goal.status='active'(lifecycle)이면서 latest_story_activity_at이 dormancy
// 임계 밖(또는 아예 없음)인 것을 "잠든 active"로 판별. status 자체의 뜻은 안 건드린다(lifecycle
// SSOT는 무변경) — 이 판별은 오직 표시용 카운트에만 쓰인다.
function isDormantActiveGoal(goal: Goal, dormancyThresholdHours: number, nowMs: number): boolean {
  if (!goal.latest_story_activity_at) return true;
  const t = new Date(goal.latest_story_activity_at).getTime();
  if (Number.isNaN(t)) return true;
  return nowMs - t > dormancyThresholdHours * 3600_000;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// story #2017: epic-status-transition.tsx의 LABEL_KEY와 동일 키(statusDraft 등) 재사용 —
// 신규 i18n 키 0.
const STATUS_FILTER_LABEL_KEY: Record<GoalStatus, string> = {
  draft: 'statusDraft',
  active: 'statusActive',
  done: 'statusDone',
  archived: 'statusArchived',
};

function statusBadgeVariant(status: GoalStatus): 'secondary' | 'info' | 'success' | 'outline' {
  switch (status) {
    case 'active':
      return 'info';
    case 'done':
      return 'success';
    case 'draft':
    case 'archived':
    default:
      return 'secondary';
  }
}

function priorityBadgeVariant(priority: GoalPriority): 'destructive' | 'secondary' | 'outline' | 'chip' {
  switch (priority) {
    case 'critical':
      return 'destructive';
    case 'high':
      return 'secondary';
    case 'medium':
      return 'outline';
    case 'low':
    default:
      return 'chip';
  }
}

function calcStoryProgress(stories: Story[]): { done: number; total: number } {
  const total = stories.length;
  const done = stories.filter((s) => s.status === 'done').length;
  return { done, total };
}

function calcSpProgress(stories: Story[]): { done: number; total: number } {
  const total = stories.reduce((sum, s) => sum + (s.story_points ?? 0), 0);
  const done = stories
    .filter((s) => s.status === 'done')
    .reduce((sum, s) => sum + (s.story_points ?? 0), 0);
  return { done, total };
}

// story #2084 근본: 'ko-KR' 하드코딩이었다 — locale=en에서도 날짜가 한국어 형식으로
// 렌더되던 원인 중 하나(dashboard-activity-timeline.tsx와 동일하게 useLocale() 값을 받는다).
function formatDate(dateStr: string | undefined, locale: string): string {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString(locale, { year: 'numeric', month: '2-digit', day: '2-digit' });
}

// ─── Sub-components ───────────────────────────────────────────────────────────

interface ProgressBarProps {
  done: number;
  total: number;
  label?: string;
}

function ProgressBar({ done, total, label }: ProgressBarProps) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div className="space-y-1">
      {label ? (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{label}</span>
          <span>{done} / {total}</span>
        </div>
      ) : null}
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
        {/* story #3005(로드맵 P2·PR-C, L2) — done/total은 물리량 게이지라 proof-blue(정체성
            신호) 대신 무채 명도. 같은 화면의 "작업(Claimed)" 바(§2)가 이미 쓰는
            bg-proof-ink-3 관례 그대로 재사용(신규 하드코딩 색 0, §7 규율). */}
        <div
          className="h-full rounded-full bg-proof-ink-3 transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

// ─── Epic Create Form ─────────────────────────────────────────────────────────

interface GoalCreateFormProps {
  projectId: string;
  orgId?: string;
  onCreated: (epic: Goal) => void;
  onCancel: () => void;
}

function GoalCreateForm({ projectId, orgId, onCreated, onCancel }: GoalCreateFormProps) {
  const t = useTranslations('goals');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<GoalPriority>('medium');
  const [targetDate, setTargetDate] = useState('');
  const [targetSp, setTargetSp] = useState('');
  const [declarations, setDeclarations] = useState<HypothesisDeclarationValue[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // story 671ea3b8(S4) — 가설 선언은 에픽 생성 자체를 막지 않는다(에픽엔 스프린트의
  // HYPOTHESIS_REQUIRED_FOR_ACTIVATION 동형 BE 하드게이트가 없다 — 그라운딩 확認). 에픽 생성
  // 성공 후 선언된 가설을 개별로 생성/링크(best-effort, 스프린트 쪽 배선과 동형 — 개별 실패는
  // 에픽 생성 자체를 되돌리지 않고 조용히 넘어간다).
  const wireDeclarations = useCallback(async (epicId: string) => {
    await Promise.all(declarations.map(async (d) => {
      try {
        const createPayload = toEpicHypothesisCreatePayload(d, projectId, epicId);
        if (createPayload) {
          await fetch('/api/hypotheses', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(createPayload),
          });
          return;
        }
        const link = toEpicHypothesisLink(d, epicId);
        if (link) {
          await fetch(`/api/hypotheses/${link.hypothesisId}/links`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(link.payload),
          });
        }
      } catch {
        // best-effort — 개별 가설 배선 실패가 에픽 생성 자체를 되돌리지 않는다.
      }
    }));
  }, [declarations, projectId]);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    setSubmitting(true);
    setError(null);

    try {
      const body: Record<string, unknown> = {
        title: title.trim(),
        description: description.trim() || undefined,
        priority,
        project_id: projectId,
        org_id: orgId,
      };
      if (targetDate) body.target_date = targetDate;
      if (targetSp) body.target_sp = Number(targetSp);

      const res = await fetch('/api/goals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) throw new Error('Failed to create epic');

      const { data } = await res.json() as { data: Goal };
      await wireDeclarations(data.id);
      onCreated(data);
    } catch {
      setError(t('createError'));
    } finally {
      setSubmitting(false);
    }
  }, [title, description, priority, targetDate, targetSp, projectId, orgId, onCreated, wireDeclarations, t]);

  return (
    <form onSubmit={(e) => { void handleSubmit(e); }} className="space-y-4">
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">{t('fieldTitle')}</label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t('fieldTitlePlaceholder')}
          required
          className="w-full rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">{t('fieldDescription')}</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('fieldDescriptionPlaceholder')}
          rows={3}
          className="w-full resize-none rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">{t('fieldPriority')}</label>
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value as GoalPriority)}
            className="w-full rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
          >
            <option value="critical">{t('priorityCritical')}</option>
            <option value="high">{t('priorityHigh')}</option>
            <option value="medium">{t('priorityMedium')}</option>
            <option value="low">{t('priorityLow')}</option>
          </select>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">{t('fieldTargetSp')}</label>
          <input
            type="number"
            min="0"
            value={targetSp}
            onChange={(e) => setTargetSp(e.target.value)}
            placeholder="0"
            className="w-full rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">{t('fieldTargetDate')}</label>
        <input
          type="date"
          value={targetDate}
          onChange={(e) => setTargetDate(e.target.value)}
          className="w-full rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
        />
      </div>

      <EpicHypothesisDeclarationSection
        projectId={projectId}
        contextTitle={title}
        contextGoal={description}
        declarations={declarations}
        onChange={setDeclarations}
      />

      {error ? <p className="text-xs text-destructive" role="alert" aria-live="assertive" aria-atomic="true">{error}</p> : null}

      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t('cancel')}
        </Button>
        <Button type="submit" size="sm" disabled={submitting || !title.trim()}>
          {submitting ? '...' : t('createGoal')}
        </Button>
      </div>
    </form>
  );
}

// ─── Epic Edit Form ───────────────────────────────────────────────────────────

interface GoalEditFormProps {
  epic: Goal;
  onSaved: (epic: Goal) => void;
  onCancel: () => void;
}

function GoalEditForm({ epic, onSaved, onCancel }: GoalEditFormProps) {
  const t = useTranslations('goals');
  const [title, setTitle] = useState(epic.title);
  const [description, setDescription] = useState(epic.description ?? '');
  const [priority, setPriority] = useState<GoalPriority>(epic.priority);
  const [targetDate, setTargetDate] = useState(epic.target_date?.slice(0, 10) ?? '');
  const [targetSp, setTargetSp] = useState(epic.target_sp !== undefined ? String(epic.target_sp) : '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    setSubmitting(true);
    setError(null);

    try {
      const body: Record<string, unknown> = {
        title: title.trim(),
        description: description.trim() || undefined,
        priority,
        // RC#2: status 제외 — generic PATCH서 봉인(BE #1651 422)·전용 transition endpoint 전용.
      };
      if (targetDate) body.target_date = targetDate;
      if (targetSp) body.target_sp = Number(targetSp);

      const res = await fetch(`/api/goals/${epic.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) throw new Error('Failed to update epic');

      const { data } = await res.json() as { data: Goal };
      onSaved({ ...data, stories: epic.stories });
    } catch {
      setError(t('updateError'));
    } finally {
      setSubmitting(false);
    }
  }, [title, description, priority, targetDate, targetSp, epic.id, epic.stories, onSaved, t]);

  return (
    <form onSubmit={(e) => { void handleSubmit(e); }} className="space-y-4">
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">{t('fieldTitle')}</label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          className="w-full rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">{t('fieldDescription')}</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          className="w-full resize-none rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
        />
      </div>

      {/* RC#2: status는 편집 폼서 제거 — 전용 POST /epics/{id}/transition(상세 헤더 transition 컨트롤·⓶)·일반 PATCH서 봉인(BE #1651·hypothesis/story 선례 동형). 편집=title/desc/priority/target만. */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">{t('fieldPriority')}</label>
        <select
          value={priority}
          onChange={(e) => setPriority(e.target.value as GoalPriority)}
          className="w-full rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
        >
          <option value="critical">{t('priorityCritical')}</option>
          <option value="high">{t('priorityHigh')}</option>
          <option value="medium">{t('priorityMedium')}</option>
          <option value="low">{t('priorityLow')}</option>
        </select>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">{t('fieldTargetDate')}</label>
          <input
            type="date"
            value={targetDate}
            onChange={(e) => setTargetDate(e.target.value)}
            className="w-full rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">{t('fieldTargetSp')}</label>
          <input
            type="number"
            min="0"
            value={targetSp}
            onChange={(e) => setTargetSp(e.target.value)}
            placeholder="0"
            className="w-full rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>
      </div>

      {error ? <p className="text-xs text-destructive" role="alert" aria-live="assertive" aria-atomic="true">{error}</p> : null}

      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t('cancel')}
        </Button>
        <Button type="submit" size="sm" disabled={submitting || !title.trim()}>
          {submitting ? '...' : t('saveChanges')}
        </Button>
      </div>
    </form>
  );
}

// ─── Epic List Row ────────────────────────────────────────────────────────────

interface GoalRowProps {
  epic: Goal;
  isSelected: boolean;
  onClick: () => void;
  onDeleteRequest: (id: string) => void;
  /** 조타 모드(status 필터=전체)일 때만 드래그 핸들·큐레이션 마커 노출. */
  sortable: boolean;
}

// story #2958 §2(doc goals-outcome-ledger-redesign-handoff) — 목표별 "결과" 텍스트 줄. 실
// outcome_result는 비정형(Record<string,unknown>)이라 수치를 지어내지 않는다(§8 "데이터 있는
// 만큼만") — 라벨 재사용 + measure_after가 있으면 그 날짜만 덧붙인다(허구 금지).
function outcomeLineText(
  t: ReturnType<typeof useTranslations<'goals'>>,
  tOutcome: ReturnType<typeof useTranslations<'outcomeLoop'>>,
  status: Goal['outcome_status'],
  measureAfter: string | null | undefined,
  locale: string,
): { text: string; tone: 'green' | 'blue' | 'neutral' } {
  if (status === 'hit') return { text: tOutcome('statusHit'), tone: 'green' };
  if (status === 'miss') return { text: tOutcome('statusMiss'), tone: 'neutral' };
  if (status === 'unmeasured') return { text: tOutcome('statusUnmeasured'), tone: 'neutral' };
  if (status === 'unmeasurable') return { text: tOutcome('statusUnmeasurable'), tone: 'neutral' };
  // pending/n_a/null — 아직 결과 없음. measure_after가 있으면 "측정 예정 · 날짜"까지만(추측 금지).
  if (measureAfter) return { text: `${t('outcomeAwaitingMeasure')} · ${formatDate(measureAfter, locale)}`, tone: 'blue' };
  return { text: tOutcome('statusPending'), tone: 'neutral' };
}

function GoalRow({ epic, isSelected, onClick, onDeleteRequest, sortable }: GoalRowProps) {
  const t = useTranslations('goals');
  const tOutcome = useTranslations('outcomeLoop');
  const locale = useLocale();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: epic.id,
    disabled: !sortable,
  });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    ...(isDragging ? { zIndex: 20, opacity: 0.9 } : {}),
  };
  const curated = typeof epic.position === 'number';
  const stories = epic.stories ?? [];
  // 0d4c89e8: BE 집계(total_stories/done_stories·#1527) 우선·detail-shape(집계 미부착)는 stories 폴백.
  // list 응답은 stories 미부착이라 폴백만으론 0/0 → BE 집계로 카드 카운트/진행바 정상화.
  const fb = calcStoryProgress(stories);
  const total = epic.total_stories ?? fb.total;
  const done = epic.done_stories ?? fb.done;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const spProgress = calcSpProgress(stories);
  const spExceeded = typeof epic.target_sp === 'number' && epic.target_sp > 0 && spProgress.total > epic.target_sp;
  const outcomeLine = outcomeLineText(t, tOutcome, epic.outcome_status, epic.measure_after, locale);

  const statusLabel: Record<GoalStatus, string> = {
    draft: t('statusDraft'),
    active: t('statusActive'),
    done: t('statusDone'),
    archived: t('statusArchived'),
  };

  const priorityLabel: Record<GoalPriority, string> = {
    critical: t('priorityCritical'),
    high: t('priorityHigh'),
    medium: t('priorityMedium'),
    low: t('priorityLow'),
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group relative flex w-full items-start gap-2 rounded-xl border px-3 py-3.5 text-left transition-all duration-150 ${
        isSelected
          ? 'border-primary/40 bg-primary/5'
          : 'border-border bg-card hover:border-primary/30 hover:bg-primary/5'
      } ${
        // story #3005(로드맵 P2·PR-C, L1) — 드래그로 «들린» 상태는 일시적 floating이라
        // --elev-overlay, rest 복귀 시 인라인 카드 기본값 --elev-card(PO 판정 2026-08-24).
        isDragging ? 'shadow-[var(--elev-overlay)]' : 'shadow-[var(--elev-card)]'
      }`}
    >
      {sortable ? (
        <button
          type="button"
          aria-label={t('steerReorderAria', { title: epic.title })}
          onClick={(e) => e.stopPropagation()}
          className="mt-0.5 flex shrink-0 cursor-grab items-center text-muted-foreground transition-colors hover:text-muted-foreground active:cursor-grabbing"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-4" aria-hidden="true" />
        </button>
      ) : null}
      <div
        className="min-w-0 flex-1 cursor-pointer space-y-2.5"
        onClick={onClick}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClick(); }}
      >
        <div className="flex items-start justify-between gap-2">
          {/* story #2958 §2/§3 — 상태 칩+결과 필이 이중 신호의 «상태·결과» 열. status 배지
              (원래 shadcn Badge)는 그대로 두되(우측 무리에 존속, 회귀 없음), 왼쪽에 proof
              색규율을 따르는 신규 칩을 하나 더 앞세운다 — outcome은 기존 OutcomeStatusBadge를
              그대로 재사용(발명 0, 색 의미 불변). ⚠️상태 칩 자체는 story #3053(2984-S5)이 아래
              MaterialChip으로 대체해 컷코너(proof-cut-xs)는 이 자리에서 이미 죽은 얘기다(주석만
              #2969 PR-1의 원 버그·#2958 원 커밋 실수 이력을 참고용으로 남겨둠) — story
              #7d7634ee(P0) 컷코너 전면 폐지와도 무관(여기는 애초에 clip-path가 없었음).
              ⚠️PR#3387 카디르 QA(2026-08-23)·유나 원작자 정본 채택(PO 갱신 지시) — **상태 칩은
              green을 아예 안 쓴다**(done+hit이어도). green은 결과(Verified) 필(OutcomeStatusBadge)
              전용 — 두 축이 색에서도 안 섞여야 "일 끝≠목표 달성"이 시각으로 선다(작업 축의 첫
              처방 "done&&hit만 green"조차 두 축을 섞는 것이라 유나 판정으로 대체됨). */}
          <div className="flex shrink-0 flex-col items-start gap-1">
            {/* story #3053(2984-S5) — MaterialChip(S1, 헤어라인+fill 0) 채택, 상태별
                bg-proof-blue-soft/bg-proof-sunk 채움 폐지. dot 신호(active=blue·비active=
                faint)는 이미 있던 신호라 그대로 KEEP. */}
            <MaterialChip className="gap-1 text-[10.5px]">
              <span className={`size-1.5 rounded-full ${epic.status === 'active' ? 'bg-proof-blue' : 'bg-proof-faint'}`} />
              {statusLabel[epic.status]}
            </MaterialChip>
            {epic.outcome_status && epic.outcome_status !== 'n_a' ? <OutcomeStatusBadge status={epic.outcome_status} /> : null}
          </div>
          <p className="min-w-0 flex-1 text-editorial-claim font-editorial-claim leading-snug text-foreground">{epic.title}</p>
          <div className="flex shrink-0 items-center gap-1.5">
            {/* story #2e583f9e(2984-S7, 유나 확定 2026-08-25) — soft-fill(bg-proof-amber-soft)
                SHIFT→헤어라인(MaterialChip). 색 신호(unconfirmed/제안 의미)는 dot로 KEEP —
                계열색 텍스트를 헤어라인 위에 그대로 두면 라이트 AA 미달이라 text-foreground로
                이전(대비표 정본 — 옅은 배경+같은 계열 글자 조합 자체가 문제). */}
            {sortable ? (
              curated ? (
                <MaterialChip className="gap-1 text-[10px] text-foreground">
                  <span className="size-1.5 rounded-full bg-proof-amber" aria-hidden="true" />
                  {t('steerCurated')} {epic.position}
                </MaterialChip>
              ) : (
                <span className="text-[10px] font-medium text-muted-foreground">{t('steerAuto')}</span>
              )
            ) : null}
            {/* Loop 제안 hook — source_loop_id 배선(P3/v2) 전엔 미표시(no-fiction·sparkle 0). */}
            {epic.source_loop_id ? (
              <MaterialChip className="gap-1 text-[10px] text-foreground">
                <span className="size-1 rounded-full bg-proof-amber" aria-hidden="true" />
                {t('steerLoopSuggest')}
              </MaterialChip>
            ) : null}
            <Badge variant={priorityBadgeVariant(epic.priority)}>{priorityLabel[epic.priority]}</Badge>
            {/* story #2104 — BE goals.py:352가 human-only로 삭제를 403 거부한다(되돌릴 수 없는
                조작). 에이전트 계정에도 트리거를 열어두면 #2091/#2103과 같은 결함이라 미리
                숨긴다. */}
            <HumanOnlyAction>
              <button
                type="button"
                aria-label={t('deleteGoal')}
                onClick={(e) => { e.stopPropagation(); onDeleteRequest(epic.id); }}
                className="hidden group-hover:flex items-center justify-center rounded-md p-1 text-muted-foreground hover:text-destructive hover:ring-1 hover:ring-inset hover:ring-destructive/60 transition-colors"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </HumanOnlyAction>
          </div>
        </div>

        {epic.description?.trim() ? (
          <p className="text-xs text-muted-foreground line-clamp-1">{epic.description.split('\n')[0]?.replace(/^#+\s*/, '')}</p>
        ) : null}

        {/* story #2958 §2 핵심 이동 — 단일 진척바 → 이중 신호(작업 Claimed 중립 / 결과 Verified).
            작업 바는 반드시 중립색(proof-ink-3) — green은 outcome=hit에만(§8 설계 확定, soul-lock). */}
        {total > 0 ? (
          <div className="flex items-center gap-2">
            <span className="w-8 shrink-0 font-mono text-[10px] text-muted-foreground">{t('taskLabel')}</span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-border">
              <div className="h-full rounded-full bg-proof-ink-3 transition-all duration-300" style={{ width: `${pct}%` }} />
            </div>
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{done}/{total}</span>
          </div>
        ) : null}
        <div className="flex items-center gap-2">
          <span className="w-8 shrink-0 font-mono text-[10px] text-muted-foreground">{t('outcomeLabel')}</span>
          {/* story #3099(DS·AA 후속, #3090과 동형) — green/blue 소형텍스트(12px) AA 미달(라이트
              green 3.49), 별도 dot 없는 자리라 text-proof-ink로 중립화(일관성 위해 blue도 동형
              처리 — #3090 선례). 의미는 텍스트 자체(outcomeLine.text)가 이미 병기. */}
          <span className={`text-xs font-semibold ${
            outcomeLine.tone === 'green' || outcomeLine.tone === 'blue' ? 'text-proof-ink' : 'text-muted-foreground'
          }`}
          >
            {outcomeLine.text}
          </span>
        </div>

        {/* 가설요약 추가로 메타 항목이 늘어 고밀도 카드(마감일+SP초과 동반)가 narrow 폭서
            가로 오버플로 잠재 → flex-wrap 헤지(가디언 라이브게이트 선제·기존 행 robustness↑). */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {epic.target_date ? (
            <span>{t('targetDate')}: {formatDate(epic.target_date, locale)}</span>
          ) : null}
          <HypothesesSummary count={epic.hypothesis_count ?? 0} riskyStatus={epic.risky_status ?? null} />
          {spExceeded ? (
            <span className="rounded-full bg-destructive-tint px-1.5 py-0.5 text-xs font-semibold text-foreground">
              {t('spExceeded')}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ─── Epic Detail Panel ────────────────────────────────────────────────────────

interface GoalDetailPanelProps {
  epic: Goal;
  onUpdate: (epic: Goal) => void;
  onClose: () => void;
}

function GoalDetailPanel({ epic, onUpdate, onClose }: GoalDetailPanelProps) {
  const t = useTranslations('goals');
  const locale = useLocale();
  const router = useRouter();
  const { wsSlug, projSlug } = useGoalsRoute();
  const [isEditing, setIsEditing] = useState(false);

  const stories = epic.stories ?? [];
  const storyProgress = calcStoryProgress(stories);
  const spProgress = calcSpProgress(stories);
  const spExceeded = typeof epic.target_sp === 'number' && epic.target_sp > 0 && spProgress.total > epic.target_sp;

  const statusLabel: Record<GoalStatus, string> = {
    draft: t('statusDraft'),
    active: t('statusActive'),
    done: t('statusDone'),
    archived: t('statusArchived'),
  };

  const priorityLabel: Record<GoalPriority, string> = {
    critical: t('priorityCritical'),
    high: t('priorityHigh'),
    medium: t('priorityMedium'),
    low: t('priorityLow'),
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-border/80 px-5 py-4">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground lg:hidden"
          >
            <ChevronLeft className="size-3.5" />
            {t('backToList')}
          </button>
          <div className="flex items-center gap-1.5">
            <Badge variant={statusBadgeVariant(epic.status)}>{statusLabel[epic.status]}</Badge>
            <Badge variant={priorityBadgeVariant(epic.priority)}>{priorityLabel[epic.priority]}</Badge>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!isEditing ? (
            <>
              <Button size="sm" variant="outline" onClick={() => router.push(`/${wsSlug}/${projSlug}/goals/${epic.id}`)}>
                {t('viewFull')}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setIsEditing(true)}>
                {t('editGoal')}
              </Button>
            </>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            className="hidden rounded-xl p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:block"
          >
            <X className="size-4" />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-5 py-5">
        {isEditing ? (
          <div className="space-y-4">
            <GoalEditForm
              epic={epic}
              onSaved={(updated) => { onUpdate(updated); setIsEditing(false); }}
              onCancel={() => setIsEditing(false)}
            />
          </div>
        ) : (
          <div className="space-y-6">
            {/* Title */}
            <h2 className="text-base font-bold text-foreground">{epic.title}</h2>

            {/* Meta grid */}
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl bg-muted px-3 py-2.5">
                <p className="text-xs font-medium text-muted-foreground">{t('targetDate')}</p>
                <p className="mt-1 text-sm font-medium text-foreground">{formatDate(epic.target_date, locale)}</p>
              </div>
              <div className="rounded-xl bg-muted px-3 py-2.5">
                <p className="text-xs font-medium text-muted-foreground">{t('targetSp')}</p>
                <div className="mt-1 flex items-center gap-1.5">
                  <p className="text-sm font-medium text-foreground">{epic.target_sp !== undefined ? epic.target_sp : '—'}</p>
                  {spExceeded ? (
                    <span className="rounded-full bg-destructive-tint px-1.5 py-0.5 text-xs font-semibold text-foreground">{t('spExceeded')}</span>
                  ) : null}
                </div>
              </div>
            </div>

            {/* Description */}
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">{t('description')}</p>
              <p className="text-sm leading-relaxed text-foreground">
                {epic.description?.trim() ? epic.description : <span className="italic text-muted-foreground">{t('noDescription')}</span>}
              </p>
            </div>

            {/* Progress */}
            <div className="space-y-3">
              <p className="text-xs font-medium text-muted-foreground">{t('storiesProgress')}</p>
              <ProgressBar done={storyProgress.done} total={storyProgress.total} label={`${t('doneStories')} / ${t('totalStories')}`} />
              {spProgress.total > 0 ? (
                <>
                  <div className="flex items-center gap-2">
                    <p className="text-xs font-medium text-muted-foreground">{t('spProgress')}</p>
                    {spExceeded ? (
                      <span className="rounded-full bg-destructive-tint px-1.5 py-0.5 text-xs font-semibold text-foreground">
                        {t('spExceededDetail', { total: spProgress.total, target: epic.target_sp ?? 0 })}
                      </span>
                    ) : null}
                  </div>
                  <ProgressBar done={spProgress.done} total={spProgress.total} label={`${t('doneSp')} / ${t('totalSp')}`} />
                </>
              ) : null}
            </div>

            {/* Story list */}
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">{t('stories')}</p>
              {stories.length > 0 ? (
                <div className="space-y-1.5">
                  {stories.map((story) => (
                    <button
                      key={story.id}
                      type="button"
                      onClick={() => router.push(`/board?story=${story.id}`)}
                      className="flex w-full items-center justify-between rounded-xl border border-border px-3 py-2 text-left transition-colors hover:border-primary/30 hover:bg-primary/5"
                    >
                      <p className="text-sm text-foreground">{story.title}</p>
                      <div className="flex shrink-0 items-center gap-2">
                        {story.story_points !== undefined ? (
                          <span className="text-xs text-muted-foreground">{story.story_points} SP</span>
                        ) : null}
                        <Badge variant={story.status === 'done' ? 'success' : 'secondary'} className="text-[10px]">
                          {story.status}
                        </Badge>
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-sm italic text-muted-foreground">{t('noStories')}</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Create Modal ─────────────────────────────────────────────────────────────

interface CreateModalProps {
  projectId: string;
  orgId?: string;
  onCreated: (epic: Goal) => void;
  onClose: () => void;
}

function CreateModal({ projectId, orgId, onCreated, onClose }: CreateModalProps) {
  const t = useTranslations('goals');

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] max-w-md flex-col overflow-hidden rounded-2xl p-0" showCloseButton={false}>
        <div className="flex flex-shrink-0 items-center justify-between px-6 pb-4 pt-6">
          <DialogTitle className="text-base font-bold text-foreground">{t('createGoal')}</DialogTitle>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>
        {/* Scrollable body — long forms (outcome 추가 등) overflow the viewport otherwise;
            internal scroll keeps every field + the submit button reachable (S5). */}
        <div className="focus-inset min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          <GoalCreateForm
            projectId={projectId}
            orgId={orgId}
            onCreated={(epic) => { onCreated(epic); onClose(); }}
            onCancel={onClose}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main Client Component ────────────────────────────────────────────────────

interface GoalsClientProps {
  projectId: string;
  orgId?: string;
}

export function GoalsClient({ projectId, orgId }: GoalsClientProps) {
  const t = useTranslations('goals');
  const router = useRouter();
  const { wsSlug, projSlug } = useGoalsRoute();
  const { toasts, addToast, dismissToast } = useToast();
  const [epics, setGoals] = useState<Goal[]>([]);
  const [selectedEpic, setSelectedEpic] = useState<Goal | null>(null);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [mobileView, setMobileView] = useState<'list' | 'detail'>('list');
  const [statusFilter, setStatusFilter] = useState<GoalStatus | 'all'>('all');
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  // wedge #2 로드맵 조타
  const [capped, setCapped] = useState(false);          // 상위 STEER_LIMIT 초과(honest 표시·silent-truncation 금지)
  const [reordering, setReordering] = useState(false);   // bulk PATCH(초안 저장) in-flight
  // STEER v2: 드래그=조용한 초안(핸드오프 없음). 핸드오프는 명시적 커밋("조타 보내기") 성공 後에만.
  const [showDispatch, setShowDispatch] = useState(false);
  const [justDispatched, setJustDispatched] = useState(false);
  const [dispatchedTo, setDispatchedTo] = useState<string[]>([]); // 지정 수신자 이름(핸드오프 표시용)
  // story #3126 — BE 단일소스(epics-progress-lane), fetch 실패 시에만 폴백.
  const [dormancyThresholdHours, setDormancyThresholdHours] = useState(DEFAULT_DORMANCY_THRESHOLD_HOURS);
  const sensors = useSensors(useSensor(MousePointerSensor, { activationConstraint: { distance: 8 } }));
  // story #2545(카디르 라이브 재QA 2단계) — org 불일치 자동교정(switch-org)이 이 fetch 直後
  // 성공하면 project는 안 바뀌므로 재요청 트리거가 없었다(project-context-client.ts 참고).
  const orgSyncVersion = useOrgSyncVersion();

  // wedge #2: order_by=position 옵트인 — 큐레이션 prefix + 자동(NULL) tail. position 모드는 BE가
  // 커서를 발행하지 않으므로 이어달리기(cursor pagination) 없이 전량(상위 STEER_LIMIT) 로드한다(AC4).
  const fetchGoals = useCallback(async () => {
    try {
      // story #3126 — include=glance로 latest_story_activity_at을 같이 받는다(신규 round-trip
      // 없음, 이미 하던 이 fetch에 옵트인 파라미터만 추가).
      const params = new URLSearchParams({
        project_id: projectId, limit: String(STEER_LIMIT), order_by: 'position', include: 'glance',
      });
      const res = await fetchWithAuth(`/api/goals?${params.toString()}`);
      if (!res.ok) throw new Error(`Failed to fetch epics: ${res.status}`);
      const { data } = await res.json() as { data: Goal[] };
      setGoals(data ?? []);
      setCapped((data?.length ?? 0) >= STEER_LIMIT);
    } catch (err) {
      // AC3: silent-swallow 금지 — 최소 로깅.
      console.error('[epics] 목록을 불러오지 못했습니다', err);
    } finally {
      setLoading(false);
    }
    // orgSyncVersion은 콜백 안에서 안 읽는다 — switch-org 성공 直後 이 콜백 새 참조를
    // 강제해 재요청시키기 위한 의도적 invalidation 트리거다(story #2545, project-context-
    // client.ts 참고).
  }, [projectId, orgSyncVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    // 조타는 전체(status=all) 뷰에서만 — 필터 서브셋 재정렬은 전역 position을 오염시킨다(가드).
    if (statusFilter !== 'all') return;
    const oldIndex = epics.findIndex((e) => e.id === active.id);
    const newIndex = epics.findIndex((e) => e.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;

    const reordered = arrayMove(epics, oldIndex, newIndex);
    const patch = computeReorderPatch(reordered, newIndex);
    if (patch.length === 0) { setGoals(reordered); return; }

    // 낙관 반영(마커 즉시 갱신) 후 실 PATCH — 성공 시 서버 확정본으로 정합, 실패 시 롤백.
    const posById = new Map(patch.map((p) => [p.id, p.position]));
    const optimistic = reordered.map((e) => (posById.has(e.id) ? { ...e, position: posById.get(e.id)! } : e));
    const prev = epics;
    setGoals(optimistic);
    setReordering(true);
    try {
      const res = await fetch('/api/goals/bulk', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: patch }),
      });
      if (!res.ok) throw new Error(`bulk reorder failed: ${res.status}`);
      const { data } = await res.json() as { data: Goal[] };
      // 응답=갱신본만 → 서버 position으로 정합(실 persist 확인·끝단 반영).
      const updById = new Map((data ?? []).map((e) => [e.id, e.position]));
      setGoals((cur) => cur.map((e) => (updById.has(e.id) ? { ...e, position: updById.get(e.id) ?? e.position } : e)));
      // STEER v2: 드래그는 조용한 초안 저장 — 핸드오프/이벤트 없음(#2078 배선 제거). 신뢰 발화는
      // 명시적 커밋(POST /epics/steer-dispatch)에서만. 인간이 A→B→A로 번복하는 초안은 새지 않는다.
    } catch (err) {
      console.error('[epics] 재정렬 저장 실패', err);
      setGoals(prev); // 롤백(낙관 UI ≠ 저장)
      addToast({ type: 'error', title: t('steerError') });
    } finally {
      setReordering(false);
    }
  }, [epics, statusFilter, addToast, t]);

  // (silent-catch sweep) `_fetchEpicDetail`(dead·호출처 0·handleSelectEpic이 /epics/[id]
  // 딥링크로 대체)는 제거했다 — 실행되지 않던 silent catch였으므로 toast가 아니라 dead code 삭제.

  const handleSelectEpic = useCallback((epic: Goal) => {
    // AC5: 모든 디바이스에서 /epics/[id] 딥링크로 이동
    router.push(`/${wsSlug}/${projSlug}/goals/${epic.id}`);
  }, [router, wsSlug, projSlug]);

  const handleDeleteEpic = useCallback(async (id: string) => {
    setDeleting(true);
    setGoals((prev) => prev.filter((e) => e.id !== id));
    setSelectedEpic((prev) => prev?.id === id ? null : prev);
    try {
      const res = await fetch(`/api/goals/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        // story #2485 — backend delete_goal()은 generic HTTP상태 코드만 낸다
        // (진짜 비즈니스 code 없음, 그라운딩 확認) — raw 서버 message 노출 대신 고정 문구.
        addToast({ type: 'error', title: '목표 삭제에 실패했습니다.' });
        void fetchGoals();
      }
    } catch {
      addToast({ type: 'error', title: '목표 삭제에 실패했습니다.' });
      void fetchGoals();
    } finally {
      setDeleting(false);
      setDeleteConfirmId(null);
    }
  }, [fetchGoals, addToast]);

  const handleCreated = useCallback((epic: Goal) => {
    setGoals((prev) => [epic, ...prev]);
    setSelectedEpic(epic);
    setMobileView('detail');
  }, []);

  const handleUpdate = useCallback((updated: Goal) => {
    setSelectedEpic(updated);
    setGoals((prev) => prev.map((e) => (e.id === updated.id ? updated : e)));
  }, []);

  useEffect(() => {
    void fetchGoals();
  }, [fetchGoals]);

  // story #3126 — dormancy_threshold_hours를 1회 조회(project_id 변경 시 재조회). 실패 시
  // DEFAULT_DORMANCY_THRESHOLD_HOURS 유지(위 useState 초기값 그대로, 별도 처리 불요).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchWithAuth(`/api/analytics/epics-progress-lane?project_id=${projectId}`);
        if (!res.ok || cancelled) return;
        const { data } = await res.json() as { data?: { dormancy_threshold_hours?: number } };
        if (!cancelled && typeof data?.dormancy_threshold_hours === 'number') {
          setDormancyThresholdHours(data.dormancy_threshold_hours);
        }
      } catch {
        // 폴백 유지 — silent이되 파괴적이지 않음(옛 하드코딩과 동일 값이 그대로 쓰인다).
      }
    })();
    return () => { cancelled = true; };
  }, [projectId]);

  if (loading) {
    return (
      <>
        <TopBarSlot title={<h1 className="text-sm font-medium">{t('title')}</h1>} showContextChip />
        <div className="flex h-64 items-center justify-center">
          <p className="text-sm text-muted-foreground">{t('loading')}</p>
        </div>
      </>
    );
  }

  const filteredGoals = statusFilter === 'all' ? epics : epics.filter((e) => e.status === statusFilter);
  // 조타(드래그 재정렬)는 전체 뷰에서만 — 필터 서브셋은 전역 position을 오염시킨다.
  const sortable = statusFilter === 'all';
  // 커밋("조타 보내기")은 큐레이션(position≠null)이 하나라도 있을 때만 의미 있다.
  const hasCurated = epics.some((e) => typeof e.position === 'number');

  // story #3126(#2341 §「52개 중 3개만 실제로 돈다」) — status='active'는 lifecycle(안 끝난
  // 것 전부)이라 이 헤드라인 카운트를 있는 그대로 쓰면 "52 active"처럼 부풀려진 수를 그대로
  // 노출한다. status='active' 중에서도 최근 dormancy 임계 안에 실제 움직임(latest_story_
  // activity_at)이 있는 것만 센다 — status 자체의 뜻(lifecycle)은 안 건드리고 이 카운트만
  // "정말 도는가"로 좁힌다.
  const activeCount = epics.filter(
    (e) => e.status === 'active' && !isDormantActiveGoal(e, dormancyThresholdHours, Date.now()),
  ).length;
  const doneCount = epics.filter((e) => e.status === 'done').length;

  const listPanel = (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-muted/35">

      {/* story #2958 §3 — 에디토리얼 마스트헤드(docs 재조립 #2955와 동형 언어, editorial 타이포
          스케일 goals 첫 소비처). TopBarSlot(아래)은 얇은 전역 브레드크럼 칩이라 존속 — 이
          마스트헤드가 실질 콘텐츠 헤더. */}
      <div className="shrink-0 border-b border-border px-4 pb-4 pt-5 sm:px-6">
        <div className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-proof-blue">{t('indexKicker')}</div>
        {/* story #2974(PR-D0) delta — font-display(페이스)+font-editorial-heading(무게 유틸,
            --font-weight-editorial-heading:820) 병기. docs-index.tsx 마스트헤드 주석 참고. */}
        <h1 className="mt-1.5 font-display font-editorial-heading text-[28px] leading-none tracking-[-0.03em] text-foreground sm:text-[34px]">{t('title')}</h1>
        {/* story #2983(유나 확定) — 정적 장식 citron 퇴출(citron=live pulse 신호 전용).
            시그니처는 무채 두께(3px)·길이로 유지. */}
        <hr className="my-3 h-[3px] w-16 border-0 bg-proof-line-strong" />
        <p className="text-editorial-ui text-muted-foreground">
          {t('indexDek')} <span className="text-muted-foreground">{t('indexCountActive', { count: activeCount })} · {t('indexCountDone', { count: doneCount })}</span>
        </p>
      </div>

      {/* Status filter — story #2017: 'all' 아닌 나머지는 raw status 값을 그대로 렌더해(t() 미호출)
          KO 로케일에서도 draft/active/done/archived 영문 그대로 보였음. 배지·드롭다운(epic-status-
          transition.tsx)이 쓰는 기존 statusXxx 키를 그대로 재사용(신규 키 0). */}
      <div className="flex shrink-0 gap-1 px-4 pt-3 pb-1 flex-wrap">
        {(['all', 'draft', 'active', 'done', 'archived'] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatusFilter(s)}
            className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors ${
              statusFilter === s
                ? 'border-primary/40 bg-primary/10 text-primary'
                : 'border-border text-muted-foreground hover:bg-muted/50'
            }`}
          >
            {s === 'all' ? t('filterAll') : t(STATUS_FILTER_LABEL_KEY[s])}
          </button>
        ))}
      </div>

      {/* STEER v2 조타 보내기(커밋) — 드래그(조용한 초안)와 분리된 명시적 발화. 큐레이션이 있고
          전체 뷰일 때만. 누르면 수신자 선택 모달 → POST /epics/steer-dispatch. */}
      {sortable && hasCurated ? (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-proof-line-soft px-4 py-2">
          <span className="min-w-0 truncate text-[11px] text-muted-foreground">{t('steerCommitHint')}</span>
          <Button size="sm" variant="outline" className="shrink-0" onClick={() => setShowDispatch(true)}>
            <Send className="mr-1.5 h-3.5 w-3.5" />
            {t('steerCommit')}
          </Button>
        </div>
      ) : null}

      {/* 조타→핸드오프 confirm — "감시 아니라 신뢰": 신뢰단계 1개만("받았고 움직인다"). STEER v2에선
          **커밋 성공 後에만** 표시(드래그 아님·no-fiction). 지정 수신자만 표기·활동량/타임스탬프 0.
          Proof Blue·부드러운 호흡·reduced-motion 대응. */}
      {justDispatched ? (
        // story #3053(2984-S5) — 헤어라인+elev(S1 재질 언어) 채택, bg-proof-blue-soft 채움
        // 폐지. pulse dot(라이브 신호)은 그대로 KEEP — proof-blue.
        <div className="flex shrink-0 items-center gap-2 border-y border-proof-line bg-proof-panel px-4 py-2 text-[11.5px] font-semibold text-foreground shadow-[var(--elev-card)]">
          <span className="size-1.5 shrink-0 rounded-full bg-proof-blue motion-safe:animate-pulse" aria-hidden="true" />
          <span>{t('steerHandoffReceived')} · <b className="font-bold">{t('steerHandoffOrchestrating')}</b></span>
          {dispatchedTo.length > 0 ? (
            <span className="ml-auto max-w-[45%] truncate text-[9.5px] font-bold text-muted-foreground">{dispatchedTo.join(', ')}</span>
          ) : null}
        </div>
      ) : null}

      {/* List body */}
      <div className="flex-1 overflow-y-auto p-4" aria-busy={reordering}>
        {filteredGoals.length === 0 ? (
          // story 3995840c — 정체성 explainer는 "진짜 빈 프로젝트"(epics.length===0)에만.
          // 필터 적용 중 결과 0건(예: 전부 done인데 draft 필터)은 "아직 시작 안 함"이 거짓이라
          // 별개의 중립 카피 유지(no-fiction — resource-view-firsttouch-identity-pattern §3
          // "이 패턴은 빈상태 전용" 규율).
          epics.length === 0 ? (
            <EmptyState
              icon={<Flag className="size-8" />}
              title={t('noGoals')}
              description={t('noGoalsDescription')}
              action={
                <div className="flex flex-col items-center gap-4">
                  <GoalGroupHint />
                  <Button size="sm" onClick={() => setShowCreate(true)}>
                    <Plus className="size-4" />
                    {t('newGoal')}
                  </Button>
                </div>
              }
            />
          ) : (
            <EmptyState
              title={t('noGoalsFiltered')}
              action={
                <Button size="sm" onClick={() => setShowCreate(true)}>
                  <Plus className="size-4" />
                  {t('newGoal')}
                </Button>
              }
            />
          )
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(e) => void handleDragEnd(e)}>
            <SortableContext items={filteredGoals.map((e) => e.id)} strategy={verticalListSortingStrategy}>
              <div className="space-y-2">
                {filteredGoals.map((epic) => (
                  <GoalRow
                    key={epic.id}
                    epic={epic}
                    sortable={sortable}
                    isSelected={selectedEpic?.id === epic.id}
                    onClick={() => { void handleSelectEpic(epic); }}
                    onDeleteRequest={(id) => setDeleteConfirmId(id)}
                  />
                ))}
                {capped ? (
                  <p className="pt-1 text-center text-[11px] text-muted-foreground">{t('steerCappedNote', { count: STEER_LIMIT })}</p>
                ) : null}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </div>
    </div>
  );

  return (
    <>
      <TopBarSlot
        title={<h1 className="text-sm font-medium">{t('title')}</h1>}
        actions={
          <Button size="sm" variant="outline" onClick={() => setShowCreate(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            {t('newGoal')}
          </Button>
        }
        showContextChip
      />

      {/* Desktop layout: list + slide-in detail panel */}
      <div className="hidden min-h-0 flex-1 overflow-hidden lg:flex lg:items-stretch lg:gap-0">
        <div className={`transition-all duration-300 ${selectedEpic ? 'w-[380px] shrink-0 border-r border-border/80' : 'w-full'}`}>
          {listPanel}
        </div>
        {selectedEpic ? (
          <div className="flex-1 min-w-0">
            <GoalDetailPanel
              epic={selectedEpic}
              onUpdate={handleUpdate}
              onClose={() => setSelectedEpic(null)}
            />
          </div>
        ) : null}
      </div>

      {/* Mobile layout */}
      {/* min-h-0 필수 — 없으면 flex item 기본 min-height:auto가 content 높이만큼 커져
          이 wrapper의 overflow-hidden이 하단 콘텐츠를 스크롤 불가하게 clip한다(desktop
          분기 L893의 min-h-0와 동형·모바일 스크롤 불가 재현+근본 확인 후 정정). */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:hidden">
        {mobileView === 'list' ? (
          <div className="min-h-0 flex-1">{listPanel}</div>
        ) : (
          <div className="min-h-0 flex-1">
            {selectedEpic ? (
              <GoalDetailPanel
                epic={selectedEpic}
                onUpdate={handleUpdate}
                onClose={() => { setSelectedEpic(null); setMobileView('list'); }}
              />
            ) : null}
          </div>
        )}
      </div>

      {/* Create modal */}
      {showCreate ? (
        <CreateModal
          projectId={projectId}
          orgId={orgId}
          onCreated={handleCreated}
          onClose={() => setShowCreate(false)}
        />
      ) : null}

      {/* STEER v2 조타 보내기(커밋) 모달 — 지정 수신자 선택 → POST /epics/steer-dispatch */}
      {showDispatch ? (
        <SteerDispatchModal
          projectId={projectId}
          items={epics
            .filter((e) => typeof e.position === 'number')
            .map((e) => ({ id: e.id, position: e.position as number }))}
          onClose={() => setShowDispatch(false)}
          onDispatched={(names) => { setDispatchedTo(names); setJustDispatched(true); setShowDispatch(false); }}
        />
      ) : null}

      {/* Delete confirm dialog */}
      <Dialog open={!!deleteConfirmId} onOpenChange={(open) => { if (!open) setDeleteConfirmId(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('deleteConfirmTitle')}</DialogTitle>
            <DialogDescription>
              {t('deleteConfirmDescription')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setDeleteConfirmId(null)} disabled={deleting}>
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => { if (deleteConfirmId) void handleDeleteEpic(deleteConfirmId); }}
              disabled={deleting}
            >
              {deleting ? t('deleting') : t('deleteConfirmButton')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}
