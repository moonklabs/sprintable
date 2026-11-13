'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { GOALS_FRAME_FACE } from './goals-layer';
import { Plus, Send, X, Flag } from 'lucide-react';
import { DndContext, type DragEndEvent, PointerSensor, useSensor, useSensors, closestCenter } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { computeReorderPatch } from '@/lib/epic-steer';
import { useOrgSyncVersion } from '@/lib/project-context-client';
import { useGoalsRoute } from './goals-context';
import { Button } from '@/components/ui/button';
import { EpicSwimlaneBoard } from '@/components/epics/epic-swimlane-board';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { EmptyState } from '@/components/ui/empty-state';

// story 3995840c(doc resource-view-firsttouch-identity-pattern §4 "에픽" 행 — 정체성=하나의 큰
// 목표·여러 스토리가 성과로·visual=선택 그룹hint): 작은 점 3개가 큰 원 하나로 모이는 형태 —
// 실험실(4노드 원형 사이클)·현황판(3-waypoint 직선)·스프린트(기간bar)와 differentiate. 과설명
// 금지 — 점+원뿐, 라벨 없음(그룹핑 자체가 메시지).
function GoalGroupHint() {
  return (
    <svg viewBox="0 0 48 24" className="size-6 w-12 text-muted-foreground" aria-hidden="true">
      {/* story #3232 — 점 3개와 원 사이에 연결 요소가 없어 «수렴/그룹핑»이 안 읽히고 별개
          마크로 보였다(버그헌트 적출). 각 점에서 원으로 향하는 faint 수렴선을 더해 «여럿이
          하나로 모인다»를 라벨 없이 읽히게 한다(과설명 금지 유지 — 선은 라벨 아님). */}
      <path d="M4 12 L25 12 M10 8 L25 12 M10 16 L25 12" stroke="currentColor" strokeWidth="1" opacity="0.35" fill="none" />
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
import { useToast } from '@/components/ui/toast';
import { EpicHypothesisDeclarationSection } from '@/components/epics/hypothesis-declaration-section';
import type { HypothesisDeclarationValue } from '@/services/hypothesis-declaration';
import { toEpicHypothesisCreatePayload, toEpicHypothesisLink } from '@/services/hypothesis-declaration-epic';
import { SteerDispatchModal } from './steer-dispatch-modal';
import { Banner } from '@/components/ds/banner';
import { Button as DsButton } from '@/components/ds/button';
import { useMediaQuery } from '@/hooks/use-media-query';
import { handleListKeys } from '@/lib/list-keys';
import { GoalDetailColumn } from './goal-detail-column';
import { GoalListRow } from './goal-list-row';
import { GoalsHead } from './goals-head';
import type { Goal, GoalEditDraft, GoalPriority, GoalStatus } from './goal-model';

import { fetchWithAuth } from '@/lib/db/client';
import { GoalsTopBarTitle } from '@/components/nav/flat-tab-top-bar';
import { useJsonFieldDraft } from '@/hooks/use-json-field-draft';

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
// (목표 · 스토리 타입과 순수 도우미는 ./goal-model.ts로 옮겼다 — story #4888)

// story #3126 — epics-progress-lane fetch가 실패했을 때만 쓰는 폴백(옛 코드가 이 신호 자체가
// 없던 시절과 동일하게 «전부 active로 인정»하지 않기 위한 최소값이 아니라, next-maker-screen.tsx
// 의 동일 상수와 정합해 같은 실패-시나리오에서 같은 값을 쓴다).
const DEFAULT_DORMANCY_THRESHOLD_HOURS = 720;

// story #3126 — Goal.status='active'(lifecycle)이면서 latest_story_activity_at이 dormancy
// 임계 밖(또는 아예 없음)인 것을 "잠든 active"로 판별. status 자체의 뜻은 안 건드린다(lifecycle
// SSOT는 무변경) — 이 판별은 오직 표시용 카운트에만 쓰인다.
function isDormantActiveGoal(goal: Goal, dormancyThresholdHours: number, nowMs: number): boolean {
  // story 4906 (customer lap ⑧) — «dormant» is «nothing has happened for the threshold»: the goal's last sign of life is its last story movement, or — when no story ever moved — the day it was
  // made. A goal made a minute ago (no stories yet) is not asleep: the head said «활성 0» beside a list whose one goal was «Active» (and kept saying it after a reload, for 30 days). A goal with
  // no sign of life at all (no activity, no creation time) stays dormant, as before.
  const stamps = [goal.latest_story_activity_at, goal.created_at].map((v) => (v ? new Date(v).getTime() : Number.NaN)).filter((n) => !Number.isNaN(n));
  if (stamps.length === 0) return true;
  return nowMs - Math.max(...stamps) > dormancyThresholdHours * 3600_000;
}

// ─── Epic Create Form ─────────────────────────────────────────────────────────

interface GoalCreateFormProps {
  projectId: string;
  orgId?: string;
  onCreated: (epic: Goal) => void;
  onCancel: () => void;
}

interface GoalCreateDraft extends GoalEditDraft { declarations: HypothesisDeclarationValue[] }
/** 목표 만들기 폼 초안의 빈 값(안정 참조 — 같은 값이면 초안 없음). */
const EMPTY_GOAL_CREATE: GoalCreateDraft = { title: '', description: '', priority: 'medium', targetDate: '', targetSp: '', declarations: [] };

function GoalCreateForm({ projectId, orgId, onCreated, onCancel }: GoalCreateFormProps) {
  const t = useTranslations('goals');
  // story #4370(유나 판정 (가)) — 여러 줄 칸(설명 · 가설 문장)이 든 폼이라 **폼 전체**가 프로젝트별 초안 하나: 창이 ✕ · 바깥 · Esc로
  // 닫혀도 남고 보이는 «취소»와 만들기 성공에서만 지운다. 키 = 표면 + 대상(새로 만들기라 프로젝트) + form.
  const [form, setForm, clearFormDraft] = useJsonFieldDraft<GoalCreateDraft>(
    { surface: 'goal-create', targetId: projectId, field: 'form' }, EMPTY_GOAL_CREATE,
  );
  const { title, description, priority, targetDate, targetSp, declarations } = form;
  const setTitle = (v: string) => setForm({ ...form, title: v });
  const setDescription = (v: string) => setForm({ ...form, description: v });
  const setPriority = (v: GoalPriority) => setForm({ ...form, priority: v });
  const setTargetDate = (v: string) => setForm({ ...form, targetDate: v });
  const setTargetSp = (v: string) => setForm({ ...form, targetSp: v });
  const setDeclarations = (v: HypothesisDeclarationValue[]) => setForm({ ...form, declarations: v });
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
      clearFormDraft();
      onCreated(data);
    } catch {
      setError(t('createError'));
    } finally {
      setSubmitting(false);
    }
  }, [title, description, priority, targetDate, targetSp, projectId, orgId, onCreated, wireDeclarations, t, clearFormDraft]);

  return (
    <form onSubmit={(e) => { void handleSubmit(e); }} className="space-y-4">
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">{t('fieldTitle')}</label>
        <Input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t('fieldTitlePlaceholder')}
          required
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">{t('fieldDescription')}</label>
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('fieldDescriptionPlaceholder')}
          rows={3}
          className="resize-none"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">{t('fieldPriority')}</label>
          <Select
            value={priority}
            onChange={(e) => setPriority(e.target.value as GoalPriority)}
          >
            <option value="critical">{t('priorityCritical')}</option>
            <option value="high">{t('priorityHigh')}</option>
            <option value="medium">{t('priorityMedium')}</option>
            <option value="low">{t('priorityLow')}</option>
          </Select>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">{t('fieldTargetSp')}</label>
          <Input
            type="number"
            min="0"
            value={targetSp}
            onChange={(e) => setTargetSp(e.target.value)}
            placeholder="0"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">{t('fieldTargetDate')}</label>
        <Input
          type="date"
          value={targetDate}
          onChange={(e) => setTargetDate(e.target.value)}
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
        <Button type="button" variant="ghost" size="sm" onClick={() => { clearFormDraft(); onCancel(); }}>
          {t('cancel')}
        </Button>
        <Button type="submit" size="sm" disabled={submitting || !title.trim()}>
          {submitting ? '...' : t('createGoal')}
        </Button>
      </div>
    </form>
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
  const tc = useTranslations('common');

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] max-w-md flex-col overflow-hidden rounded-2xl p-0" showCloseButton={false}>
        <div className="flex flex-shrink-0 items-center justify-between px-6 pb-4 pt-6">
          <DialogTitle className="text-base font-bold text-foreground">{t('createGoal')}</DialogTitle>
          <button
            type="button"
            onClick={onClose}
            aria-label={tc('close')}
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
  /**
   * story #4888(UI-5 목표 화면 둘째 조각) — 주소가 보기를 정하는 진입(`/epics` = 일감 탭줄의 «목표» 탭 = 스윔레인으로 열림). 있으면 저장된 보기보다 먼저고 프로젝트가 바뀌어도 이 보기로 다시 서며,
   * 그 진입에서 누른 전환은 이번 화면에만 닿는다(저장하지 않는다 — `/goals`가 다음에 열릴 때 기본 보기를 이 진입이 바꾸지 않게). 없으면 예전 그대로(기본 목록 · 프로젝트별 기억).
   */
  initialView?: 'list' | 'swimlane';
}

export function GoalsClient({ projectId, orgId, initialView }: GoalsClientProps) {
  const t = useTranslations('goals');
  const tc = useTranslations('common');
  const router = useRouter();
  const { wsSlug, projSlug } = useGoalsRoute();
  // story #4888(UI-5 목표 화면 첫 조각) — «보기: 목록 | 스윔레인». 에픽 탭(/epics 스윔레인)과 목표 화면(/goals)을 한 화면으로 합친다: 같은 마스트헤드 아래에서 보기만 갈아 낀다.
  // 기본은 목록(예전 /goals 그대로). 고른 보기는 프로젝트별로 이 브라우저에 기억한다(스윔레인 보드가 축 전환을 기억하는 것과 같은 방식 · 저장이 막혀도 화면은 선다).
  // 보기는 «어느 프로젝트의 보기인가»와 같이 든다: 프로젝트가 바뀐 첫 렌더에서 이전 프로젝트의 보기로 한 번 그려지며 쓸데없는 목록 읽기가 나가지 않게, 프로젝트가 다르면 그 자리에서 바로 새 프로젝트의 보기를 계산한다.
  const resolveView = useCallback((pid: string): 'list' | 'swimlane' => {
    if (initialView) return initialView; // 주소가 보기를 정한다 — 저장값은 안 읽는다
    try {
      if (typeof window !== 'undefined' && window.localStorage.getItem(`goals-view:${pid}`) === 'swimlane') return 'swimlane';
    } catch { /* 저장소 막힘 — 기본 보기로 */ }
    return 'list';
  }, [initialView]);
  const [viewState, setViewState] = useState<{ pid: string; v: 'list' | 'swimlane' }>({ pid: projectId, v: initialView ?? 'list' });
  const view = viewState.pid === projectId ? viewState.v : resolveView(projectId);
  useEffect(() => {
    // 처음 열 때(저장값 읽기)와 프로젝트 · 진입 주소가 바뀔 때 상태를 그 프로젝트의 보기로 맞춘다(저장값이 없으면 기본 목록 — 이전 프로젝트의 보기를 끌고 가지 않는다).
    setViewState({ pid: projectId, v: resolveView(projectId) });
  }, [projectId, resolveView]);
  const setView = useCallback((next: 'list' | 'swimlane') => {
    setViewState({ pid: projectId, v: next });
    if (initialView) return; // 주소가 정한 진입의 전환은 이번 화면만(기억은 /goals의 몫)
    try { window.localStorage.setItem(`goals-view:${projectId}`, next); } catch { /* 저장 못 해도 이번 화면은 바뀐다 */ }
  }, [projectId, initialView]);
  const { addToast } = useToast();
  const [epics, setGoals] = useState<Goal[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // story #4888 — wide screens (≥1024, the `lg` breakpoint) carry the detail column beside the list; narrower ones open the goal's own page, as they always did
  const isWide = useMediaQuery('(min-width: 1024px)');
  // story #4888 — «이 프로젝트의 목표 목록을 읽었나». 예전엔 한 번 읽으면 끝나는 `loading` 불리언이었는데, 스윔레인 보기는 이 목록을 읽지 않고(보드가 자기 읽기를 쥔다) 프로젝트가 바뀌면 이전 프로젝트의
  // 목록이 남을 수 있어, 어느 프로젝트의 목록인지를 같이 든다 — 목록 보기는 이 값이 지금 프로젝트일 때만 서고, 마스트헤드 수도 그때만 보인다.
  const [loadedProject, setLoadedProject] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
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
  // story #4888 — 응답 뒤섞임 방어(codex 3차): 읽기마다 번호표(순번)를 붙이고 «가장 마지막에 시작한 읽기»만 반영한다. 프로젝트 비교만으로는 같은 프로젝트의 겹친 읽기(조직 동기화로 다시 읽기 ·
  // A→B→A 이동)에서 오래된 응답이 새 응답을 덮는 것을 못 막는다. 프로젝트가 바뀌는 순간에는 이전 프로젝트의 목록을 바로 비우고(아래 효과) 진행 중 읽기를 무효로 만든다.
  const fetchSeqRef = useRef(0);
  const listProjectRef = useRef<string | null>(null); // `epics` 상태가 어느 프로젝트의 것인가(null = 비었거나 아직 안 읽음)
  const currentProjectRef = useRef(projectId);        // 지금 화면의 프로젝트 — 옛 프로젝트의 클로저가 늦게 다시 읽기를 부르는 것(삭제 실패 뒤 재읽기)을 시작에서 거절한다
  useEffect(() => { currentProjectRef.current = projectId; }, [projectId]);
  // 읽기가 진행 중일 때 만든 목표 — 그 읽기의 응답에는 없을 수 있어 응답에 합쳐 넣는다(오래된 응답이 방금 만든 목표를 덮어 사라지게 하지 않는다). atSeq = 만든 때의 읽기 순번.
  const createdRef = useRef<Array<{ goal: Goal; atSeq: number }>>([]);
  const fetchGoals = useCallback(async () => {
    if (currentProjectRef.current !== projectId) return; // 다른 프로젝트로 옮긴 뒤 옛 클로저가 부른 재읽기 — 지금 프로젝트의 읽기를 건드리지 않는다
    const seq = ++fetchSeqRef.current;
    try {
      // story #3126 — include=glance로 latest_story_activity_at을 같이 받는다(신규 round-trip
      // 없음, 이미 하던 이 fetch에 옵트인 파라미터만 추가).
      const params = new URLSearchParams({
        project_id: projectId, limit: String(STEER_LIMIT), order_by: 'position', include: 'glance',
      });
      const res = await fetchWithAuth(`/api/goals?${params.toString()}`);
      if (!res.ok) throw new Error(`Failed to fetch epics: ${res.status}`);
      const { data } = await res.json() as { data: Goal[] };
      if (seq !== fetchSeqRef.current) return; // 더 나중에 시작한 읽기가 있다(같은 프로젝트의 겹친 읽기 · 프로젝트 이동) — 이 응답은 버린다
      const fetched = data ?? [];
      // 이 읽기를 시작한 뒤에 만든 목표(atSeq >= seq)가 응답에 없으면 앞에 합친다. 이 읽기보다 나중에 시작한 읽기가 이미 본 것(atSeq < seq)은 서버가 알고 있으니 목록에서 뺀다.
      const extra = createdRef.current.filter((c) => c.atSeq >= seq && !fetched.some((d) => d.id === c.goal.id)).map((c) => c.goal);
      createdRef.current = createdRef.current.filter((c) => c.atSeq >= seq);
      setGoals(extra.length > 0 ? [...extra, ...fetched] : fetched);
      setCapped(fetched.length >= STEER_LIMIT);
      listProjectRef.current = projectId;
    } catch (err) {
      // AC3: silent-swallow 금지 — 최소 로깅.
      console.error('[epics] 목록을 불러오지 못했습니다', err);
    } finally {
      if (seq === fetchSeqRef.current) setLoadedProject(projectId);
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

  // story #4888 — a click on a row: wide → it is chosen and its detail stands in the column beside the list; narrow (phone · small window) → the goal's own page (the deep link `/goals/[id]`, as before).
  const handleSelectGoal = useCallback((goal: Goal) => {
    if (isWide) setSelectedId(goal.id);
    else router.push(`/${wsSlug}/${projSlug}/goals/${goal.id}`);
  }, [isWide, router, wsSlug, projSlug]);

  const handleDeleteEpic = useCallback(async (id: string) => {
    setDeleting(true);
    setGoals((prev) => prev.filter((e) => e.id !== id));
    setSelectedId((prev) => (prev === id ? null : prev));
    try {
      const res = await fetch(`/api/goals/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        // story #2485 — backend delete_goal()은 generic HTTP상태 코드만 낸다
        // (진짜 비즈니스 code 없음, 그라운딩 확認) — raw 서버 message 노출 대신 고정 문구.
        addToast({ type: 'error', title: t('goalDeleteFailed') });
        void fetchGoals();
      }
    } catch {
      addToast({ type: 'error', title: t('goalDeleteFailed') });
      void fetchGoals();
    } finally {
      setDeleting(false);
      setDeleteConfirmId(null);
    }
  }, [fetchGoals, addToast, t]);

  const handleCreated = useCallback((epic: Goal) => {
    // 다른 프로젝트로 옮긴 뒤에야 도착한 «만들기 응답» — 그 목표는 서버에 만들어졌지만 지금 화면(다른 프로젝트)의 목록에 끼어들면 안 된다(그 프로젝트를 다시 열면 읽기로 들어온다).
    if (currentProjectRef.current !== projectId) return;
    setGoals((prev) => [epic, ...prev]);
    createdRef.current.push({ goal: epic, atSeq: fetchSeqRef.current });
    listProjectRef.current = projectId; // 상태에 이 프로젝트의 목표가 들어왔다 — 프로젝트를 옮길 때 비워야 할 대상
    // wide: the new goal is chosen and stands in the detail column · narrow: its own page opens (what a tap on its row does)
    if (isWide) setSelectedId(epic.id);
    else router.push(`/${wsSlug}/${projSlug}/goals/${epic.id}`);
  }, [projectId, isWide, router, wsSlug, projSlug]);

  // the edit's answer has no story counts (BE puts those on the list only) — merged over the row so the row keeps its progress
  const handleUpdate = useCallback((updated: Goal) => {
    setGoals((prev) => prev.map((e) => (e.id === updated.id ? { ...e, ...updated } : e)));
  }, []);

  // story #4888 — 목록 읽기는 «목록 보기»일 때만. 스윔레인 보기(= `/epics` 진입 포함)는 보드가 자기 읽기 · 시간초과 · 실패 표시를 쥐므로, 여기서 또 읽거나 그 읽기를 기다리면
  // 목록 읽기가 느릴 때 보드의 «느림 vs 멈춤» 표시(story #3019)가 가려지고 같은 /api/goals를 두 번 읽는다. 목록 보기로 넘어올 때 읽는다.
  const needsGoals = view === 'list';
  // 프로젝트가 바뀌는 순간: 진행 중이던 읽기를 무효로 하고, 상태에 남은 «다른 프로젝트의 목록»을 바로 비운다(실패 경로에서 지우는 것이 아니라 이동 시점에 — 방금 이 프로젝트에서 만든 목표를 실패가 지우지 않게).
  // 이 효과는 아래 읽기 효과보다 먼저 선언돼 같은 커밋에서 먼저 돈다.
  useEffect(() => {
    fetchSeqRef.current += 1;
    createdRef.current = [];
    if (listProjectRef.current !== null && listProjectRef.current !== projectId) {
      setGoals([]);
      setCapped(false);
      setSelectedId(null);
      listProjectRef.current = null;
    }
    // «읽음» 표시도 같이 비운다 — 비운 목록을 «이 프로젝트의 목록을 읽은 것»으로 보고 0 · 0을 정확한 수처럼 보이는 구멍(A → B(스윔레인) → A)을 막는다. 처음 열 때는 이미 null이다.
    setLoadedProject((prev) => (prev === projectId ? prev : null));
  }, [projectId]);
  useEffect(() => {
    if (!needsGoals) return;
    void fetchGoals();
  }, [fetchGoals, needsGoals]);

  // story #3126 — dormancy_threshold_hours를 1회 조회(project_id 변경 시 재조회). 실패 시
  // DEFAULT_DORMANCY_THRESHOLD_HOURS 유지(위 useState 초기값 그대로, 별도 처리 불요).
  useEffect(() => {
    if (!needsGoals) return; // 이 값은 마스트헤드 «진행 중» 수에만 쓰인다 — 목록 보기일 때만 읽는다
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
  }, [projectId, needsGoals]);

  const goalsReady = loadedProject === projectId;
  if (view === 'list' && !goalsReady) {
    return (
      <>
        {/* story #3945 — 아래 :1157(본문 «목표» 제목)이 이 페이지의 진짜 h1이다. 로딩
            상태에도 같은 TopBarSlot 라벨을 쓰므로 일관되게 비-헤딩(<p>)으로. */}
        <TopBarSlot title={<GoalsTopBarTitle />} showContextChip />
        {/* story #3946(유나 확認·페드루 정정) — 로딩 상태엔 본문 마스트헤드(:1157)가 아직
            안 그려져 h1이 0개가 되던 gap. 시각은 무변(스크린리더 전용) — sr-only h1로
            "페이지 h1 항상 정확히 1개" 불변식을 로딩 분기에서도 지킨다. */}
        <h1 className="sr-only">{t('title')}</h1>
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

  // story #4888 (UI-5, the goals screen · AC3 §4-2) — list + detail, like home: on a wide screen the goals stand in a 420px list column and the goal chosen stands in the detail column beside it
  // (the first goal is chosen when none is — never an empty column); on a phone the list is the whole screen and a row opens the goal's own page. One DOM for both (no hidden second copy).
  const showDetail = isWide && filteredGoals.length > 0;
  const effectiveSelectedId = showDetail ? (filteredGoals.some((e) => e.id === selectedId) ? selectedId : filteredGoals[0]!.id) : null;
  const selectedGoal = effectiveSelectedId ? epics.find((e) => e.id === effectiveSelectedId) ?? null : null;
  const counts = goalsReady ? { active: activeCount, done: doneCount } : null;
  // one head for both views — the head itself decides that the state filter belongs to the list view only
  const head = <GoalsHead view={view} onViewChange={setView} counts={counts} filter={statusFilter} onFilterChange={setStatusFilter} />;
  // the frame's height: the window minus the shell and the work-tabs band (so the screen does not scroll the page by the band's height)
  const frame = `h-[calc(100svh-var(--shell-chrome-h)-var(--work-tabs-h,0px))] min-h-0 flex-col overflow-hidden ${GOALS_FRAME_FACE}`;

  const listColumn = (
    <div data-testid="goals-list-column" className={`flex min-h-0 w-full min-w-0 flex-col ${showDetail ? 'lg:w-[420px] lg:shrink-0 lg:border-r lg:border-ds-line' : ''}`}>
      {/* STEER v2 조타 보내기(커밋) — 드래그(조용한 초안)와 분리된 명시적 발화. 큐레이션이 있고 전체 뷰일 때만. 누르면 수신자 선택 모달 → POST /epics/steer-dispatch. */}
      {sortable && hasCurated ? (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-ds-line px-4 py-2">
          <span className="min-w-0 truncate text-ds-small text-ds-ink-3">{t('steerCommitHint')}</span>
          <DsButton type="button" variant="secondary" className="shrink-0" iconStart={<Send className="size-3.5" aria-hidden="true" />} onClick={() => setShowDispatch(true)}>
            {t('steerCommit')}
          </DsButton>
        </div>
      ) : null}

      {/* 조타→핸드오프 confirm — "감시 아니라 신뢰": 신뢰단계 1개만("받았고 움직인다"). STEER v2에선 **커밋 성공 後에만** 표시(드래그 아님·no-fiction). 지정 수신자만 표기·활동량/타임스탬프 0. */}
      {justDispatched ? (
        <Banner tone="info" className="shrink-0 border-x-0">
          <span>{t('steerHandoffReceived')} · <b className="font-semibold">{t('steerHandoffOrchestrating')}</b></span>
          {dispatchedTo.length > 0 ? <span className="ml-2 font-mono text-ds-mono-md text-ds-ink-3">{dispatchedTo.join(', ')}</span> : null}
        </Banner>
      ) : null}

      {/* List body — story #4888: j / k / ↑ / ↓ walk the rows on a wide screen (the same keys as home); Enter on a row's title chooses it */}
      <div
        data-testid="goals-list"
        className="focus-inset min-h-0 flex-1 overflow-y-auto"
        aria-busy={reordering}
        onKeyDown={isWide ? (e) => handleListKeys(e, (key) => setSelectedId(key)) : undefined}
      >
        {filteredGoals.length === 0 ? (
          // story 3995840c — 정체성 explainer는 "진짜 빈 프로젝트"(epics.length===0)에만. 필터 적용 중 결과 0건은 "아직 시작 안 함"이 거짓이라 별개의 중립 카피 유지(no-fiction).
          <div className="p-4">
            {epics.length === 0 ? (
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
            )}
          </div>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(e) => void handleDragEnd(e)}>
            <SortableContext items={filteredGoals.map((e) => e.id)} strategy={verticalListSortingStrategy}>
              <div>
                {filteredGoals.map((epic) => (
                  <GoalListRow
                    key={epic.id}
                    goal={epic}
                    sortable={sortable}
                    selected={effectiveSelectedId === epic.id}
                    onSelect={handleSelectGoal}
                    onDeleteRequest={(id) => setDeleteConfirmId(id)}
                  />
                ))}
                {capped ? (
                  <p className="m-0 px-4 py-3 text-center text-ds-small text-ds-ink-3">{t('steerCappedNote', { count: STEER_LIMIT })}</p>
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
        title={<GoalsTopBarTitle />}
        actions={
          // story #4277 — 402폭에서 글자 버튼이 상단바를 가로로 넘쳤다(410/402 · 가드가 잡음). 스프린트 상단바 관례: 폰은 아이콘만 · 접근 이름 aria-label.
          // story #4888 — the ds Button carries the touch 44 floor (the old ui/Button size=sm stayed 36×28 on a phone); the icon alone on a phone, icon + words from `sm` up
          <DsButton type="button" variant="secondary" onClick={() => setShowCreate(true)} aria-label={t('newGoal')} iconStart={<Plus className="size-3.5" aria-hidden="true" />}>
            <span className="hidden sm:inline">{t('newGoal')}</span>
          </DsButton>
        }
        showContextChip
      />

      {view === 'swimlane' ? (
        // story #4888 — 스윔레인 보기: 보드는 «한 곳에만» 그린다. 머리(h1 · 보기 전환)는 목록 보기와 같은 것, 상단바 슬롯은 위의 것(목표 제목 + 새 목표) 하나만 — 보드는 embedded로 자기 슬롯을 안 그린다.
        <div className={`flex ${frame}`} data-testid="goals-swimlane-view">
          {head}
          <div className="focus-inset min-h-0 flex-1 overflow-y-auto">
            <EpicSwimlaneBoard projectId={projectId} embedded />
          </div>
        </div>
      ) : (
        <div className={`flex ${frame}`} data-testid="goals-screen">
          {head}
          <div className="flex min-h-0 flex-1">
            {listColumn}
            {showDetail && selectedGoal ? (
              <aside data-testid="goals-detail-column" className="flex min-h-0 min-w-0 flex-1">
                <GoalDetailColumn key={selectedGoal.id} goal={selectedGoal} projectId={projectId} onUpdate={handleUpdate} />
              </aside>
            ) : null}
          </div>
        </div>
      )}

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
              {deleting ? tc('deleting') : t('deleteConfirmButton')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </>
  );
}
