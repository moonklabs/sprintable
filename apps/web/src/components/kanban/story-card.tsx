'use client';

import { firstGraphemes } from '@/lib/first-graphemes';
import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useLocale, useTranslations } from 'next-intl';
import { pickEulReulJosa } from '@/lib/korean-particle';
import type { KanbanStory, KanbanMember, LineStatusSummary } from './types';
import { parseStoryCardTitle } from '@/lib/story-card-title';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { AlertTriangle, Check, ChevronRight, Clock, EyeOff, History, MoreHorizontal, Pause, Zap, ZapOff, type LucideIcon } from 'lucide-react';
import { UnnamedMemberIcon } from '@/components/shared/unnamed-member-icon';
import { AGENT_MARK_FILL_CLASS } from '@/components/ui/agent-identity';
import { LabelChip } from '@/components/ui/label-chip';
import { MaterialChip } from '@/components/ui/material-chip';
import { cn } from '@/lib/utils';
import { HOVER_REVEAL, HOVER_REVEAL_FOCUS_RING, HOVER_REVEAL_HIT } from '@/lib/hover-reveal';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { deriveTrustStage } from '@/services/verify';
import { formatViewerRelativeTime } from '@/lib/storage/format';
import { memberDisplayLabel, memberRowLabels } from '@/lib/member-display';
import { Input } from '@/components/ui/input';
import { isImeComposing } from '@/lib/ime-composition';
import { LAYER } from '@/components/ds/layers';
import { moveCardFocus } from './card-nav';
import { useViewerTimeZone } from '@/components/viewer-time-zone';

// #1942 재작업(까심 REQUEST_CHANGES): 카드-상대 flip(left-0/right-0)은 보드가 가로스크롤이라
// 카드 자체가 뷰포트 밖으로 밀려나면(신고 재현: 컬럼 280px, 카드 x=215~471, 뷰포트 390px) 어느
// 쪽으로 flip해도 못 푼다 — 카드 우측 모서리(471)조차 이미 뷰포트 밖이라 "카드 기준 반대쪽"도
// 여전히 뷰포트 밖. 뷰포트 좌표로 직접 clamp해야 카드 위치와 무관하게 항상 화면 안에 들어온다.
const MENU_WIDTH = 240; // 4908 — 192(w-48)에서 올렸다: 상태 칩 다섯(백로그 · 개발 대기 · 진행 중 · 리뷰 중 · 완료)이 «3+2» 두 줄로 고르게 들어가는 폭(192는 2+2+1로 들쭉날쭉). 담당자 서브메뉴도 같은 폭.
const VIEWPORT_MARGIN = 8;

function clampToViewport(x: number): number {
  return Math.min(Math.max(x, VIEWPORT_MARGIN), window.innerWidth - MENU_WIDTH - VIEWPORT_MARGIN);
}

// 4908 — 세로도 뷰포트 안으로(화면 아래쪽 카드에서 «⋯»를 눌러도 메뉴 항목이 화면 밖으로 안 나간다). 항목 하나 ≈ 36px(py-2 + text-sm) + 메뉴 안쪽 여백 8px.
const MENU_ITEM_HEIGHT = 36;
// 4908 — 새로 더한 메뉴 항목(이름 바꾸기 · 담당자)은 날것 단추 태그가 아니라 디자인 Button(ghost)을 메뉴 항목 모양으로 쓴다(가드 verify:no-new-raw-button).
const MENU_ITEM_BUTTON = 'h-auto min-h-0 min-w-0 w-full justify-start rounded-sm px-3 py-2 text-left text-sm font-normal whitespace-normal hover:bg-muted';
// 4908 — 상태 칩 줄은 칩이 줄바꿈되고(폭 240 안에서 보통 두 줄 · 긴 조직 라벨이면 더) 폰에서는 칩이 44px 높이라 항목 하나(36px)로 셀 수 없다: 이름 줄 20 + 두 줄 × (44 + 간격 4) + 안쪽 여백 12 = 128px, 긴 라벨 한 줄 여유 48을 더해 176px를 한 덩어리로 잡는다(넉넉한 쪽). 항목 수에는 1로 세고(⋯ 단추 유무도 이 수), 모자란 140px를 더한다.
const STATUS_ROW_EXTRA_HEIGHT = 176 - MENU_ITEM_HEIGHT;
function clampTopToViewport(y: number, itemCount: number, extraPx = 0): number {
  return Math.max(VIEWPORT_MARGIN, Math.min(y, window.innerHeight - (itemCount * MENU_ITEM_HEIGHT + extraPx + 8) - VIEWPORT_MARGIN));
}

// E-MODERN A: 에픽 식별 dot — 기존 시맨틱 토큰만(신규 토큰/raw 팔레트 0). 신호색(warning=blocked·
// accent-claim=agent·destructive) 회피해 의미 충돌 0. 랜덤 5색 채움 배지(loud)는 퇴출.
const EPIC_DOT_CLASSES = ['bg-info', 'bg-success', 'bg-secondary', 'bg-muted-foreground'] as const;

function getEpicDotClass(epicId: string): string {
  const hash = epicId.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  return EPIC_DOT_CLASSES[hash % EPIC_DOT_CLASSES.length]!;
}

// story #4284 — 구성원 이름은 nullable. 이름 없는 구성원은 머리글자 대신 사람 아이콘(유나 4286 판정 — «?» 머리글자 → 사람 아이콘),
// 전체 라벨(«이름 없는 구성원»)은 title로. 라벨 앞 두 자(«이름»)를 머리글자로 쓰면 실명처럼 읽힌다.
function getInitials(name: string): string {
  return firstGraphemes(name, 2).toUpperCase();
}

// E-DG S11 ①: workflow-line badge 5상태(LineStatusSummary + 기존 pending gate 두 소스 merge).
type LineBadgeState = 'handoff_stuck' | 'waiting_human' | 'pending_gate' | 'engine_degraded' | 'grandfathered';

// human gate 대기 step run status(BE _blocking_reason gate-대기 분기와 정합).
const WAITING_HUMAN_STATUSES = new Set(['gate_pending', 'waiting_gate', 'waiting_parallel']);

// boy-scout 절제: 카드엔 우선순위 1배지만(행동필요 > 정보성).
// handoff_stuck > waiting_human > pending gate > engine_degraded > grandfathered.
function deriveLineBadge(line: LineStatusSummary | undefined, hasPendingGate: boolean): LineBadgeState | null {
  if (line?.has_active) {
    if (line.handoff_stuck) return 'handoff_stuck';
    if (line.status && WAITING_HUMAN_STATUSES.has(line.status)) return 'waiting_human';
  }
  if (hasPendingGate) return 'pending_gate';
  if (line?.has_active) {
    if (line.engine_degraded) return 'engine_degraded';
    if (line.grandfathered) return 'grandfathered';
  }
  return null;
}

// pending_gate 는 gate_type 동반이라 렌더서 특수처리 → meta 는 신규 4상태만.
const LINE_BADGE_META: Record<
  Exclude<LineBadgeState, 'pending_gate'>,
  { variant: 'destructive' | 'warning' | 'outline'; Icon: LucideIcon; labelKey: string }
> = {
  handoff_stuck: { variant: 'destructive', Icon: AlertTriangle, labelKey: 'lineHandoffStuck' },
  waiting_human: { variant: 'warning', Icon: Pause, labelKey: 'lineWaitingHuman' },
  engine_degraded: { variant: 'outline', Icon: EyeOff, labelKey: 'lineEngineDegraded' },
  grandfathered: { variant: 'outline', Icon: History, labelKey: 'lineGrandfathered' },
};

interface WorkflowExecStatus {
  status: string;
  rule_name?: string | null;
  completed_at?: string | null;
}

interface StoryCardProps {
  story: KanbanStory;
  epicName?: string;
  assignee?: KanbanMember;
  assignees?: KanbanMember[];
  onClick: () => void;
  onEdit?: (storyId: string) => void;
  onChangeStatus?: (storyId: string, newStatus: string) => void;
  onAssign?: (storyId: string) => void;
  onDelete?: (storyId: string) => void;
  projectId?: string;
  onKickoff?: (storyId: string, result: 'triggered' | 'no_match' | 'conflict' | 'error') => void;
  lastExecution?: WorkflowExecStatus | null;
  blockedBy?: string[];
  labels?: { id: string; name: string; color: string | null }[];
  gates?: { id: string; gate_type: string; status: string }[];
  lineStatus?: LineStatusSummary;
  /** E-VERIFY P0-04 — story.human_verified_by(UUID)를 호출부가 미리 resolve해 넘긴 것(assignee/
   * assignees와 동일 패턴). 결재자가 현재 담당자가 아닐 수 있어(assigneeList와 별개 조회). */
  verifiedBy?: KanbanMember;
  /** story #3287([도메인탈고정·축1 Phase1] AC4) — org별 status 라벨 오버라이드 조회 함수
   * (useOrgDomainLabels().statusLabel). 없으면(undefined) 기존 t(...) canonical 문구 그대로
   * (회귀 0) — 어떤 축(classic/trust) 카드든 story.status 자체가 바뀌는 게 아니라 여기 표시
   * 텍스트만 바뀐다. */
  getStatusLabel?: (canonicalSlug: string) => string | undefined;
  /** story #2933 H4(P0-H) — 트러스트축 파생 컬럼(needs_input/verified/merge_ready)의 카드는
   * 게이트/증거 사실이 소속을 계산한다(v4 결정⑤ — 빼는 길=게이트 해소뿐). true면 드래그 wiring
   * 자체를 끄고(useSortable disabled, dnd-kit 리스너 미부착 — goals-client.tsx/retro page.tsx의
   * `disabled: !sortable`류 기존 관례 재사용) "상태 변경" 우클릭 메뉴도 숨긴다(수동 상태변경도
   * 이 카드엔 안 맞음 — 게이트가 정하므로). 클릭(상세 열기)은 그대로 살아있다. */
  locked?: boolean;
  /** story #3043(PO+유나 IA 확定 ⓒ, 2026-08-25) — (옛 CardVariant 시절) 카드 틀이
   * `max-w-[280px]`를 하드코딩(desktop KanbanColumn 고정폭 전제) — 모바일 단일열(list) 재사용 시
   * full-width row가 되려면 이 캡을 호출부가 override해야 한다. `cn()`이 twMerge라 나중 클래스가
   * 이긴다 — 새 prop 없이 max-w-none을 넘기면 그대로 해소(신규 시각 언어 발명 없음). */
  className?: string;
  /** 4908 — 지금 상세 패널이 열려 있는 카드(열린 카드 층 + 왼쪽 막대). */
  selected?: boolean;
  /** 4908 — 상태 글을 머리 줄에 보인다. 열이 곧 상태인 칸에서는 끈다(같은 것을 두 자리에 안 보인다) — 한 열에 상태가 둘 섞이는 «대기» 열(백로그 / 개발 대기)과 목록 보기만 켠다. */
  showStatus?: boolean;
  /** 4908 — 메뉴 «담당자 ▸»에 올릴 후보(시스템 발행 제외 · 중복 없음). 없으면 예전 «담당자 지정»(onAssign) 항목 그대로. */
  assignableMembers?: KanbanMember[];
  /** 4908 — 메뉴 «담당자 ▸»에서 한 사람을 켜고 끈다(패널 «담당자»와 같은 PATCH — 호출부가 소유). */
  onToggleAssignee?: (storyId: string, memberId: string) => void;
  /** 4908 — 제목 바로 바꾸기(더블클릭 · F2 · 메뉴 «이름 바꾸기»). 패널 제목 PATCH와 같은 일 — 호출부가 소유. */
  onRename?: (storyId: string, title: string) => void;
}

export function StoryCard({ story, epicName, assignee, assignees, onClick, onEdit, onChangeStatus, onAssign, onDelete, projectId, onKickoff, lastExecution, blockedBy = [], labels = [], gates = [], lineStatus, verifiedBy, locked = false, className, getStatusLabel, selected = false, showStatus = false, assignableMembers = [], onToggleAssignee, onRename }: StoryCardProps) {
  const t = useTranslations('board');
  const tc = useTranslations('common');
  const locale = useLocale();
  const displayTimezone = useViewerTimeZone(); // story #4443 PR2b — the viewer's zone (null until known)
  // E-BOARD S6: 복수 assignee. assignees 우선, 없으면 단일 assignee 폴백. agent 한 명이라도 있으면 agent 취급(glow).
  const assigneeList = (assignees && assignees.length > 0) ? assignees : (assignee ? [assignee] : []);
  // E-VERIFY P0-04(claimed-vs-verified-spec-handoff §3) — has_evidence 뭉갬을 2신호로 분리.
  // verified는 human_verified_by 실 resolve 성공 시만(없으면 "누가"를 지어내지 않고 무표시로
  // 후퇴 — claimed는 특정 신원 없이도 범용 봇 아이콘으로 정직 렌더 가능해 후퇴 불필요).
  const trustStage = deriveTrustStage(story);
  const tCage = useTranslations('cage');
  const tv = useTranslations('verify');
  // S11 ①: line badge — 신규 4상태(LineStatusSummary) + 기존 pending gate merge, boy-scout 1배지.
  const hasPendingGate = gates.some((g) => g.status === 'pending');
  const lineBadge = deriveLineBadge(lineStatus, hasPendingGate);
  const lineBadgeMeta = lineBadge && lineBadge !== 'pending_gate' ? LINE_BADGE_META[lineBadge] : null;
  const pendingGateType = lineBadge === 'pending_gate' ? gates.find((g) => g.status === 'pending')?.gate_type : undefined;

  // story #32dcc294(v2 #2, 시안 a230cfd5) — 제목 파싱: 선두 [태그]→카테고리 칩, 나머지는
  // verbatim lead(리라이트 0, 3015 규율 동일). #번호는 story.story_number를 그대로 쓴다
  // (이전엔 claim 문자열 앞에 직접 접두했으나, 이제 headerAside로 분리 렌더).
  const { categoryTag, lead: titleLead } = parseStoryCardTitle(story.title);

  // boy-scout 절제: «행동 필요» 신호 중 최우선 1개만 카드 상단 1급 라인("다음: …")으로
  // 승격한다. 각 분기 텍스트는 meta row가 이미 만들던 문구 그대로(diff로 신규 파생 0
  // 증명) — 위치·강조만 바뀐다. 정보성(engine_degraded·grandfathered)은 승격 대상 아님.
  const isBlockedForAction = blockedBy.length > 0 && story.status !== 'done';
  const nextAction: { Icon: LucideIcon; label: string } | null = isBlockedForAction
    ? { Icon: AlertTriangle, label: t('blockedBy', { count: blockedBy.length }) }
    : lineBadge === 'handoff_stuck'
    ? { Icon: LINE_BADGE_META.handoff_stuck.Icon, label: tCage(LINE_BADGE_META.handoff_stuck.labelKey) }
    : lineBadge === 'waiting_human'
    ? { Icon: LINE_BADGE_META.waiting_human.Icon, label: tCage(LINE_BADGE_META.waiting_human.labelKey) }
    : lineBadge === 'pending_gate'
    ? { Icon: Pause, label: pendingGateType ? `${pendingGateType} ${tCage('gatePending')}` : tCage('gatePending') }
    : null;
  // 승격된 lineBadge 신호는 meta row에서 중복 렌더하지 않는다(같은 신호를 두 자리에 보여
  // 주지 않음 — boy-scout 1배지 원칙 유지). blocked가 승격을 가져간 경우엔 lineBadge가
  // 여전히 별개 사실이라 meta row에 남을 수 있다(중복 아님).
  const lineBadgePromoted = !isBlockedForAction
    && (lineBadge === 'handoff_stuck' || lineBadge === 'waiting_human' || lineBadge === 'pending_gate');
  // 메뉴에 항목이 하나도 없는 카드(에픽 스윔레인 — 조작 콜백을 안 받는다)는 «⋯» 버튼도 없다(빈 메뉴가 열리는 것을 막는다).
  const assignViaSubmenu = !!onToggleAssignee && assignableMembers.length > 0;
  const menuItemCount = (onEdit ? 1 : 0) + (onRename ? 1 : 0) + (onChangeStatus && !locked ? 1 : 0) + (assignViaSubmenu || onAssign ? 1 : 0) + (projectId ? 1 : 0) + (onDelete ? 1 : 0);
  const statusRowPx = onChangeStatus && !locked ? STATUS_ROW_EXTRA_HEIGHT : 0;
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  // story #2416 — native confirm() 대체.
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [assignMenuOpen, setAssignMenuOpen] = useState(false);
  const [assignMenuPos, setAssignMenuPos] = useState<{ top: number; left: number } | null>(null);
  const assignMenuRef = useRef<HTMLDivElement>(null);
  const assignTriggerRef = useRef<HTMLButtonElement>(null);
  const returnFocusToAssignTriggerRef = useRef(false);
  // 4908 — 제목 바로 바꾸기: 입력칸이 제목 자리를 대신한다. 두 번 저장되지 않게(Enter 뒤 blur) 끝낸 표시를 ref로.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const renameDoneRef = useRef(false);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [triggering, setTriggering] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  // Esc/항목선택으로 메뉴를 닫을 때만 포커스를 카드로 되돌린다(클릭-밖/스크롤/리사이즈로
  // 닫힐 때는 사용자가 이미 다른 곳에 의도를 두고 있어 포커스를 뺏지 않는다).
  const returnFocusOnCloseRef = useRef(false);
  const closeContextMenu = useCallback((returnFocus: boolean) => {
    setContextMenuOpen(false);
    setAssignMenuOpen(false);
    if (returnFocus) {
      returnFocusOnCloseRef.current = true;
    }
  }, []);
  const closeAssignSubmenu = useCallback((returnFocus: boolean) => {
    setAssignMenuOpen(false);
    if (returnFocus) returnFocusToAssignTriggerRef.current = true;
  }, []);
  // #1942: 두 메뉴 다 position:fixed + 뷰포트 좌표 clamp(clampToViewport)로 연다 — 트리거(카드/
  // 버튼)의 화면 위치와 무관하게 항상 뷰포트 안에 들어온다(카드-상대 anchor는 카드 자체가 뷰포트
  // 밖일 때 답이 없다는 게 까심 QA 적출).
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);

  const handleKickoff = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!projectId || triggering) return;
    setTriggering(true);
    try {
      const res = await fetch('/api/workflow/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, story_id: story.id, trigger_type_slug: 'kickoff' }),
      });
      if (res.status === 409) {
        onKickoff?.(story.id, 'conflict');
      } else if (res.ok) {
        const data = await res.json() as { status: string };
        onKickoff?.(story.id, data.status === 'triggered' ? 'triggered' : 'no_match');
      } else {
        onKickoff?.(story.id, 'error');
      }
    } catch {
      onKickoff?.(story.id, 'error');
    } finally {
      setTriggering(false);
    }
  }, [projectId, story.id, triggering, onKickoff]);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: story.id,
    data: { story },
    disabled: locked,
  });
  // story #3664 — dnd-kit의 listeners.onKeyDown(키보드 드래그 픽업/이동)을 그대로 두되,
  // Shift+F10/ContextMenu 키만 가로채 메뉴를 연다(handleCardKeyDown). 나머지 키는 그대로
  // dnd-kit에 위임 — 드래그 키보드 조작 회귀 0.
  const { onKeyDown: dndOnKeyDown, ...dndListenersWithoutKeyDown } = listeners ?? {};
  // story #3664(유나 발견 — role=menu/menuitem 없는 맨 div) — 카드 자체가 메뉴 트리거다
  // (우클릭 대상). cardRef는 dnd-kit의 setNodeRef와 별개 로컬 ref(합성 콜백으로 합친다) —
  // 키보드로 메뉴를 열 때(Shift+F10) 좌표 기준이 필요하고, Esc로 닫을 때 포커스를 돌려줄
  // 대상이 필요하다(둘 다 setNodeRef만으로는 못 읽는다 — dnd-kit 내부가 그 DOM 노드를
  // 다른 용도로 관리하지 이 컴포넌트에 되돌려주지 않는다).
  const cardRef = useRef<HTMLDivElement>(null);
  const setCardRefs = useCallback((node: HTMLDivElement | null) => {
    setNodeRef(node);
    cardRef.current = node;
  }, [setNodeRef]);

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    // Touch dnd: pan-x pan-y lets a swipe scroll natively in BOTH axes. 0d142311: the drag
    // sensor (MousePointerSensor) now ignores pointerType==='touch' entirely, so touch never
    // starts a drag — pan-x pan-y just guarantees native scroll; press-and-hold drives the
    // context menu, not a drag. `none` would kill scroll-on-card.
    // 0a36762d: pan-y alone (S6) preserved vertical column scroll but BLOCKED horizontal board
    // scroll — columns sit in an `overflow-x-auto` row (scrollW>clientW), so a horizontal swipe
    // starting on a card had no native scroll. pan-x pan-y restores horizontal board scroll
    // (superset of pan-y → no regression to vertical scroll or desktop drag).
    touchAction: 'pan-x pan-y' as const,
  };

  // Close menu on click outside — 서브메뉴는 이제 별도 portal(body 직계)이라 menuRef 서브트리
  // 밖에 있다. 둘 중 하나라도 담고 있으면 outside로 치지 않는다.
  useEffect(() => {
    if (!contextMenuOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      const insideMenu = menuRef.current?.contains(target);
      const insideAssignMenu = assignMenuRef.current?.contains(target);
      if (!insideMenu && !insideAssignMenu) {
        closeContextMenu(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [contextMenuOpen, closeContextMenu]);

  // Close menu on Escape
  useEffect(() => {
    if (!contextMenuOpen) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // story #3664 CHANGES — 서브메뉴가 열려 있으면 Esc는 서브메뉴만 닫고 상위(트리거
        // 버튼)로 복귀한다. 상위 메뉴 자체는 그대로 열어 둔다(전체 종료가 아님).
        if (assignMenuOpen) {
          closeAssignSubmenu(true);
        } else {
          closeContextMenu(true);
        }
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [contextMenuOpen, assignMenuOpen, closeContextMenu, closeAssignSubmenu]);

  // story #3664 AC2 — 메뉴가 열리면 첫 항목으로 포커스를 옮긴다(ARIA menu 관례: 열림=포커스
  // 진입). 포털이 이 effect보다 먼저 커밋되므로 querySelector 시점엔 이미 DOM에 있다.
  useEffect(() => {
    if (!contextMenuOpen) return;
    const first = menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"], [role="menuitemradio"]');
    first?.focus();
  }, [contextMenuOpen]);

  // 4908 — 담당자 서브메뉴: 열리면 첫 항목으로 · Esc로 닫히면 트리거로 포커스 복귀(상태 서브메뉴와 같은 관례).
  useEffect(() => {
    if (!assignMenuOpen) return;
    assignMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]')?.focus();
  }, [assignMenuOpen]);
  useEffect(() => {
    if (assignMenuOpen) return;
    if (!returnFocusToAssignTriggerRef.current) return;
    returnFocusToAssignTriggerRef.current = false;
    assignTriggerRef.current?.focus();
  }, [assignMenuOpen]);

  // story #3664 AC2 — Esc/항목선택으로 닫힐 때만(closeContextMenu(true)) 포커스를 카드로
  // 되돌린다. contextMenuOpen이 false로 커밋된 *다음* effect 타이밍에 실행돼야 포털이 이미
  // 사라진 뒤라 focus() 대상(카드)이 안전하다.
  useEffect(() => {
    if (contextMenuOpen) return;
    if (!returnFocusOnCloseRef.current) return;
    returnFocusOnCloseRef.current = false;
    cardRef.current?.focus();
  }, [contextMenuOpen]);

  // 열려있는 동안 스크롤/리사이즈되면 닫는다(까심 QA 지적 ②) — 보드 컬럼의 overflow-x-auto
  // 가로스크롤은 캡처 리스너로만 잡힌다(스크롤 이벤트는 버블링하지 않음). 재측정 대신 close가
  // 더 안전한 이유: 열려 있는 동안 실측 위치를 계속 갱신하면 클릭 도중 메뉴가 움직여 오조작
  // 위험이 생긴다 — 스크롤 즉시 닫고 다시 열게 하는 편이 안전.
  useEffect(() => {
    if (!contextMenuOpen) return;
    const closeOnScrollOrResize = () => {
      closeContextMenu(false);
    };
    window.addEventListener('scroll', closeOnScrollOrResize, true);
    window.addEventListener('resize', closeOnScrollOrResize);
    return () => {
      window.removeEventListener('scroll', closeOnScrollOrResize, true);
      window.removeEventListener('resize', closeOnScrollOrResize);
    };
  }, [contextMenuOpen, closeContextMenu]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // 우클릭/롱프레스 지점(뷰포트 좌표)을 그대로 앵커로 쓰고 뷰포트 폭 안으로 clamp — 카드가
    // 어디 있든(가로스크롤로 화면 밖까지 걸쳐 있어도) 메뉴는 항상 화면 안에서 뜬다.
    setMenuPos({ top: clampTopToViewport(e.clientY, menuItemCount, statusRowPx), left: clampToViewport(e.clientX) });
    setContextMenuOpen(true);
  }, [menuItemCount, statusRowPx]);

  // ── 4908 제목 바로 바꾸기(더블클릭 · F2 · 메뉴 «이름 바꾸기») ─────────────────────────────────────────────
  const startRename = useCallback(() => {
    if (!onRename) return;
    renameDoneRef.current = false;
    setDraft(story.title);
    setEditing(true);
  }, [onRename, story.title]);

  // refocus: 키보드로 끝낼 때(Enter · Esc)만 카드로 초점을 돌려준다. 다른 곳을 눌러 빠져나간(blur) 경우엔 그 사람이 옮긴 초점을 가로채지 않는다.
  const finishRename = useCallback((save: boolean, refocus: boolean) => {
    if (renameDoneRef.current) return;
    renameDoneRef.current = true;
    const next = draft.trim();
    setEditing(false);
    if (save && next && next !== story.title) onRename?.(story.id, next);
    if (refocus) cardRef.current?.focus();
  }, [draft, story.id, story.title, onRename]);

  useEffect(() => {
    if (!editing) return;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [editing]);


  // 클릭 = 열기(바로 — 기다림 없음). 더블클릭도 «열기»다(저장소 · 결재함 · 에이전트 목록과 같은 뜻): 첫 클릭이 서랍을 열고, 둘째 클릭이 서랍 막에 닿아도 서랍은 안 닫힌다(story-detail-panel의 막 규칙).
  // 제목 바꾸기는 F2 · 메뉴 «이름 바꾸기»(그리고 서랍 안 제목)가 맡는다.
  const handleCardClick = useCallback(() => {
    if (editing) return;
    onClick();
  }, [editing, onClick]);

  // story #3664 AC2 — 키보드로 메뉴 열기(Shift+F10 또는 Menu/ContextMenu 키, OS 표준
  // "컨텍스트 메뉴 열기" 제스처). 우클릭과 동형으로 카드의 바운딩 사각형을 앵커로 쓴다
  // (마우스 좌표가 없으니 카드 자체의 화면 위치를 대신 쓴다 — 담당자 서브메뉴를
  // 여는 자리와 같은 패턴).
  const handleCardKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault();
      const rect = cardRef.current?.getBoundingClientRect();
      if (rect) {
        setMenuPos({ top: clampTopToViewport(rect.bottom, menuItemCount, statusRowPx), left: clampToViewport(rect.left) });
      }
      setContextMenuOpen(true);
      return;
    }
    // 끌고 있는 동안(키보드 끌기: Space로 집은 뒤)의 Enter · 방향키 · Space · Esc는 끌기 센서가 문서에서 받는다 — 카드는 «열기»나 초점 이동으로 가로채지 않는다.
    if (isDragging) return;
    // 방향키 = 이웃 카드로 초점 이동(↑↓ 같은 열 · ←→ 이웃 열). 카드 자신에게 초점이 있고 수정키가 없을 때만.
    if (e.target === e.currentTarget && !editing && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.key.startsWith('Arrow')) {
      if (moveCardFocus(e.currentTarget, e.key)) { e.preventDefault(); return; }
    }
    // Enter = 열기(4908 Q4 — 끌기는 Space). 잠긴(파생) 열 카드는 끌기가 없으니 Space도 열기(단추 역할의 기본 약속). 카드 자신에게 초점이 있을 때만.
    if (e.target === e.currentTarget && !editing && (e.key === 'Enter' || (locked && e.key === ' '))) {
      e.preventDefault();
      onClick();
      return;
    }
    if (e.key === 'F2' && onRename && e.target === e.currentTarget) {
      e.preventDefault();
      startRename();
      return;
    }
    // 카드 «안쪽»에서 올라온 키(포털 메뉴 항목의 Space · 안쪽 단추)는 끌기로 넘기지 않는다 — 메뉴 항목을 Space로 누르다 끌기가 시작되면 안 된다.
    if (e.target !== e.currentTarget) return;
    dndOnKeyDown?.(e);
  }, [dndOnKeyDown, menuItemCount, statusRowPx, onRename, startRename, editing, locked, onClick, isDragging]);

  // 4908 — 카드 «⋯» 버튼: 카드 안 어디서나 같은 메뉴를 연다(우클릭과 같은 메뉴 · 앵커만 버튼 아래).
  const openMenuFromButton = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setMenuPos({ top: clampTopToViewport(rect.bottom, menuItemCount, statusRowPx), left: clampToViewport(rect.left) });
    setContextMenuOpen(true);
  }, [menuItemCount, statusRowPx]);

  // story #3664 — 메뉴/서브메뉴 컨테이너 공용 키보드 순회(위/아래 화살표로 role="menuitem"
  // 사이 이동, wrap). Enter/Space는 네이티브 <button> 활성화로 이미 동작해 별도 처리 0.
  const handleMenuKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      // 상태 칩 줄: 칩 사이를 ←/→로 오간다(끝에서 반대쪽 끝으로). 초점이 칩이 아닌 항목에 있으면(indexOf = -1) 아무 일도 하지 않는다.
      const chips = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
      const at = chips.indexOf(document.activeElement as HTMLButtonElement);
      if (at === -1) return;
      e.preventDefault();
      e.stopPropagation();
      chips[(at + (e.key === 'ArrowRight' ? 1 : -1) + chips.length) % chips.length]?.focus();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    // story #3664 CHANGES(유나 QA) — 서브메뉴는 body portal이라 DOM 트리 상 상위 메뉴 밖에
    // 있지만, React는 JSX(포털을 만든) 트리를 기준으로 synthetic event를 버블링한다 — 그대로
    // 두면 서브메뉴 안의 방향키가 상위 메뉴의 이 같은 핸들러에도 도달해 e.currentTarget이
    // 상위 메뉴 div로 바뀌어(현재 컨테이너 기준 querySelectorAll) 엉뚱한(상위) 항목 집합에서
    // 포커스를 옮긴다. stopPropagation으로 "방향키는 서브메뉴 안에서만 순회"를 보장한다.
    e.stopPropagation();
    const container = e.currentTarget;
    const items = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]'));
    if (items.length === 0) return;
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    const direction = e.key === 'ArrowDown' ? 1 : -1;
    const nextIndex = currentIndex === -1
      ? (direction === 1 ? 0 : items.length - 1)
      : (currentIndex + direction + items.length) % items.length;
    items[nextIndex]?.focus();
  }, []);

  const handleEdit = useCallback(() => {
    if (onEdit) {
      onEdit(story.id);
    }
    closeContextMenu(true);
  }, [story.id, onEdit, closeContextMenu]);

  const handleChangeStatusClick = useCallback((newStatus: string) => {
    if (onChangeStatus) {
      onChangeStatus(story.id, newStatus);
    }
    closeContextMenu(true);
  }, [story.id, onChangeStatus, closeContextMenu]);

  const handleAssign = useCallback(() => {
    if (onAssign) {
      onAssign(story.id);
    }
    closeContextMenu(true);
  }, [story.id, onAssign, closeContextMenu]);

  const handleDelete = useCallback(() => {
    setDeleteConfirmOpen(true);
    closeContextMenu(true);
  }, [closeContextMenu]);

  const confirmDelete = useCallback(() => {
    setDeleteConfirmOpen(false);
    if (onDelete) onDelete(story.id);
  }, [story.id, onDelete]);

  const statuses = [
    { id: 'backlog', label: getStatusLabel?.('backlog') ?? t('backlog') },
    { id: 'ready-for-dev', label: getStatusLabel?.('ready-for-dev') ?? t('readyForDev') },
    { id: 'in-progress', label: getStatusLabel?.('in-progress') ?? t('inProgress') },
    { id: 'in-review', label: getStatusLabel?.('in-review') ?? t('inReview') },
    { id: 'done', label: getStatusLabel?.('done') ?? t('done') },
  ];

  // 열린 카드(action-soft 면)에서는 흐린 글(ink-3)이 다크에서 4.29:1로 모자란다(layer-rule.test) — 한 단계 진한 ink-2로.
  const metaInk = selected ? 'text-ds-ink-2' : 'text-ds-ink-3';
  // 메뉴 «담당자 ▸» 후보 — 이름 없는 구성원이 둘 이상이면 id 꼬리로 가른다(패널 «담당자»와 같은 규칙).
  const assigneeChoices = (() => {
    const rowLabels = memberRowLabels(assignableMembers, tc, () => '');
    return assignableMembers.map((m) => ({ id: m.id, label: rowLabels.get(m.id) ?? memberDisplayLabel(m.name, tc) }));
  })();
  // 메타 앞 묶음이 잘릴 때 전부 보이는 툴팁(카테고리 · 에픽 · 라벨 전부 · 라인 배지 · 실행 결과)과 씰 문구.
  const lineBadgeText = lineBadgePromoted ? '' : lineBadge === 'pending_gate'
    ? (pendingGateType ? `${pendingGateType} ${tCage('gatePending')}` : tCage('gatePending'))
    : lineBadgeMeta ? tCage(lineBadgeMeta.labelKey) : '';
  const execTitle = lastExecution
    ? [
        lastExecution.rule_name ?? t('workflowExecuted'),
        lastExecution.completed_at ? formatViewerRelativeTime(lastExecution.completed_at, locale, displayTimezone) : '',
        lastExecution.status === 'matched' ? `✅ ${t('ruleMatched')}` : `⊘ ${t('ruleNone')}`,
      ].filter(Boolean).join(' · ')
    : '';
  const metaFoldTitle = [categoryTag, epicName && story.epic_id ? epicName : '', labels.map((l) => l.name).join(', '), lineBadgeText, execTitle].filter(Boolean).join(' · ');
  const sealTitle = story.status === 'done' && trustStage === 'verified' && verifiedBy
    ? [tv('trustSealVerifiedBy', { name: verifiedBy.name ?? memberDisplayLabel(null, tc) }), story.human_verified_at ? formatViewerRelativeTime(story.human_verified_at, locale, displayTimezone) : '', tv('trustSealSignedOff')].filter(Boolean).join(' · ')
    : `${tv('trustSealClaimedBy')} · ${tv('trustSealAwaitingVerificationLong')}`;
  const proofStateLabel = statuses.find((s) => s.id === story.status)?.label ?? story.status;

  return (
    <div
      ref={setCardRefs}
      style={style}
      // 잠긴(파생) 열 카드는 끌 수 없지만 키보드로는 닿아야 한다(Tab 초점 · Shift+F10 메뉴 · F2 이름 바꾸기 · Enter 열기): 끌기 속성 대신 단추 역할 + tabIndex만.
      {...(locked ? { role: 'button', tabIndex: 0 } : attributes)}
      {...(locked ? {} : dndListenersWithoutKeyDown)}
      onClick={handleCardClick}
      onContextMenu={handleContextMenu}
      onKeyDown={handleCardKeyDown}
      // story #3664 AC1 — 카드=메뉴 트리거. aria-haspopup/expanded로 "이 카드가 여는 메뉴가
      // 있다·지금 열려 있다"를 스크린리더에 알린다(role은 dnd-kit attributes가 이미
      // "button"으로 준다 — 새로 안 얹는다).
      aria-haspopup="menu"
      aria-expanded={contextMenuOpen}
      data-story-card=""
      data-story-id={story.id}
      aria-current={selected ? 'true' : undefined}
      data-selected={selected ? 'true' : undefined}
      title={story.story_number ? `#${story.story_number}` : story.title}
      // 4908 — 카드는 «글 줄 층»(LAYER.rowOthers), 열린 카드는 «열린 카드 층»(LAYER.rowSelected) + 왼쪽 막대(면 차이가 작아 막대가 함께 가른다).
      className={cn(
        'group relative w-full min-w-0 cursor-pointer rounded-lg border px-3 py-1.5 transition',
        'outline-none focus-visible:ring-2 focus-visible:ring-ds-action',
        selected ? `${LAYER.rowSelected} border-ds-action` : `${LAYER.rowOthers} border-ds-line hover:border-ds-line-strong`,
        className,
      )}
    >
      {selected ? <span aria-hidden="true" data-testid="story-card-selected-bar" className="absolute inset-y-1.5 left-0 w-[3px] rounded-r-full bg-ds-action" /> : null}

      {/* 줄 1 — 번호 · (대기 열만) 상태 글 · 경고 칩 1개 · ⋯. «다음: …» 경고는 예전 그대로 우선순위 1개만(문구 · 규칙 불변) */}
      <div className={cn('flex min-h-5 items-center gap-1.5 text-editorial-meta', metaInk)}>
        {story.story_number ? <span className="shrink-0 font-mono">#{story.story_number}</span> : null}
        {showStatus ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-ds-ink-2">
            <span className="size-1.5 shrink-0 rounded-full bg-ds-ink-3" aria-hidden="true" />
            {proofStateLabel}
          </span>
        ) : null}
        {nextAction ? (
          <span className="inline-flex min-w-0 items-center gap-1 rounded-md bg-ds-needs-hand-soft px-1.5 font-semibold text-ds-needs-hand">
            <nextAction.Icon className="size-3 shrink-0" aria-hidden="true" />
            <span className="min-w-0 truncate">{t('nextActionPrefix')} {nextAction.label}</span>
          </span>
        ) : null}
        <span className="flex-1" />
        {menuItemCount > 0 ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-haspopup="menu"
          aria-label={t('cardMenuButton', { title: story.title })}
          title={t('cardMenuButton', { title: story.title })}
          aria-expanded={contextMenuOpen}
          onClick={openMenuFromButton}
          // 카드 바깥 div가 dnd-kit 끌기(pointerdown)와 키 처리(Space/Enter = 집기)를 소유한다 — 이 버튼의 누름 · Enter/Space가 거기로 새면 끌기가 시작되거나 집기로 읽힌다. 그 밖의 키(Esc · Tab · Shift+F10)는 그대로 흘려 보낸다.
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); }}
          // 터치 폰은 누르는 자리 44×44(음수 margin으로 줄 높이는 그대로) — 호버 없는 기기는 늘 보이고, 마우스는 카드 호버 · 초점 때 보인다.
          className={cn('-my-0.5 -mr-1', metaInk, 'hover:bg-ds-surface-sunk hover:text-ds-ink touch:-my-3 touch:size-11', HOVER_REVEAL_HIT, HOVER_REVEAL, HOVER_REVEAL_FOCUS_RING)}
        >
          <MoreHorizontal className="size-4" aria-hidden="true" />
        </Button>
        ) : null}
      </div>

      {/* 줄 2 — 제목(2줄까지) */}
      {editing ? (
        <Input
          ref={renameInputRef}
          value={draft}
          aria-label={t('renameStoryInput', { title: story.title })}
          onChange={(e) => setDraft(e.target.value)}
          // 카드 바깥 div는 끌기(pointerdown) · 키(Space/Enter = 집기) · 클릭(열기)을 소유한다 — 입력 중인 글자가 거기로 새면 안 된다.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onBlur={() => finishRename(true, false)}
          onKeyDown={(e) => {
            e.stopPropagation();
            // 한글 등 입력기 조합 중의 엔터는 «글자 확정 키»다 — 저장으로 읽으면 반쯤 쓴 제목이 저장된다(4831).
            if (isImeComposing(e)) return;
            if (e.key === 'Enter') { e.preventDefault(); finishRename(true, true); }
            else if (e.key === 'Escape') finishRename(false, true);
          }}
          className="mt-0.5 h-7 min-h-0 px-2 py-0 text-base font-semibold lg:text-editorial-ui"
        />
      ) : (
        <div className="mt-0.5 line-clamp-2 text-editorial-ui font-semibold leading-snug text-ds-ink">{titleLead}</div>
      )}

      {/* 줄 3 — 메타 한 줄(높이 20px 고정): 앞 묶음 = 카테고리 · 에픽 · 라벨(2개까지 + «+N») · 승격 안 된 라인 배지 · 실행 결과 / 뒤 묶음 = 포인트 · 씰 · 담당.
          좁은 칸(열 최소 240 · 폰 390)에서 다 못 담으면 줄을 늘리지 않고 앞 묶음의 뒤쪽(낮은 순위)이 잘리고, 잘린 것 전부는 앞 묶음의 툴팁에 있다(DOM에는 다 있어 스크린리더는 다 읽는다). 뒤 묶음(누가 · 얼마)은 안 줄어든다. */}
      <div className="mt-1 flex h-5 items-center gap-1.5 overflow-hidden">
        <div data-testid="story-card-meta-lead" title={metaFoldTitle || undefined} className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
          {categoryTag ? <MaterialChip className="shrink-0 py-px">{categoryTag}</MaterialChip> : null}
          {epicName && story.epic_id ? (
            <span className={cn('flex min-w-0 max-w-[40%] shrink-0 items-center gap-1 text-editorial-meta', metaInk)}>
              <span className={`size-1.5 shrink-0 rounded-sm ${getEpicDotClass(story.epic_id)}`} aria-hidden="true" />
              <span className="min-w-0 truncate">{epicName}</span>
            </span>
          ) : null}
          {labels.slice(0, 2).map((label) => (
            <LabelChip key={label.id} label={label} className="shrink-0" />
          ))}
          {labels.length > 2 ? <span className={cn('shrink-0 text-editorial-meta', metaInk)}>+{labels.length - 2}</span> : null}
          {lineBadgePromoted ? null : lineBadge === 'pending_gate' ? (
            <Badge variant="outline" className="gap-1">
              <Pause className="size-3 shrink-0" />
              <span>{pendingGateType ? `${pendingGateType} ${tCage('gatePending')}` : tCage('gatePending')}</span>
            </Badge>
          ) : lineBadgeMeta ? (
            // 실 alert(handoff_stuck=destructive · waiting_human=warning)는 색 = 신호 유지, 정보성(engine_degraded · grandfathered)만 outline.
            <Badge variant={lineBadgeMeta.variant} className="gap-1">
              <lineBadgeMeta.Icon className="size-3 shrink-0" />
              <span>{tCage(lineBadgeMeta.labelKey)}</span>
            </Badge>
          ) : null}
          {lastExecution ? (
            <span title={execTitle} className="flex h-5 w-5 shrink-0 items-center justify-center">
              {lastExecution.status === 'matched' ? (
                <Zap className="h-3 w-3 text-ds-needs-hand" />
              ) : (
                <ZapOff className={cn('h-3 w-3', metaInk)} />
              )}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {story.story_points != null ? (
            <span className={cn('shrink-0 text-editorial-meta tabular-nums', metaInk)}>{t('storyPointsBadge', { count: story.story_points })}</span>
          ) : null}
          {/* E-VERIFY P0-04 — 증거 있는 done 카드에만(무증거 = 완전 무표시). 카드에서는 작은 표시 한 알(긴 «씰» 띠는 상세에 있다 — 카드 3줄을 지킨다): 검증됨 = 체크(done 색) · 주장만 = 시계(주의 색 — 초록 아님, 에이전트 주장 단독은 초록이 될 수 없다). 전체 문구는 툴팁 + 스크린리더 글. */}
          {story.status === 'done' && trustStage === 'verified' && verifiedBy ? (
            <span data-testid="story-card-seal" data-seal="verified" title={sealTitle} className="inline-flex h-5 shrink-0 items-center text-ds-done">
              <Check className="size-3.5" strokeWidth={3} aria-hidden="true" />
              <span className="sr-only">{sealTitle}</span>
            </span>
          ) : story.status === 'done' && trustStage === 'claimed' ? (
            <span data-testid="story-card-seal" data-seal="claimed" title={sealTitle} className="inline-flex h-5 shrink-0 items-center text-ds-needs-hand">
              <Clock className="size-3.5" aria-hidden="true" />
              <span className="sr-only">{sealTitle}</span>
            </span>
          ) : null}
          {assigneeList.length > 0 ? (
            <div className="flex shrink-0 -space-x-1.5">
              {assigneeList.slice(0, 3).map((m) => (
                <div
                  key={m.id}
                  // 에이전트 = 네모에 가까운 채움 마크 · 사람 = 동그라미(story #3049 규칙 그대로). «에이전트» 글은 아바타의 스크린리더 글로.
                  className={cn(
                    'relative flex h-5 w-5 items-center justify-center rounded-full border text-micro font-medium ring-1 ring-ds-surface-high',
                    m.type === 'agent'
                      ? cn('border-proof-blue/30', AGENT_MARK_FILL_CLASS)
                      : 'border-ds-line bg-ds-surface-sunk text-ds-ink-2',
                  )}
                  title={memberDisplayLabel(m.name, tc)}
                >
                  {m.name ? getInitials(m.name) : <UnnamedMemberIcon type={m.type} />}
                  {m.type === 'agent' ? (
                    <>
                      <span className="absolute -bottom-px -right-px h-[6px] w-[6px] rounded-full bg-info ring-1 ring-ds-surface-high" />
                      <span className="sr-only">{t('filterAgents')}</span>
                    </>
                  ) : null}
                </div>
              ))}
              {assigneeList.length > 3 && (
                <div className="flex h-5 w-5 items-center justify-center rounded-full border border-ds-line bg-ds-surface-sunk text-micro font-medium text-ds-ink-2 ring-1 ring-ds-surface-high">
                  +{assigneeList.length - 3}
                  {assigneeList.slice(3).some((m) => m.type === 'agent') ? <span className="sr-only">{t('filterAgents')}</span> : null}
                </div>
              )}
            </div>
          ) : null}
        </div>
      </div>

      {/* Context Menu — body portal + position:fixed(뷰포트 좌표 clamp), 카드 위치와 무관하게 항상 화면 안 */}
      {contextMenuOpen && menuPos && createPortal(
        <div
          ref={menuRef}
          role="menu"
          tabIndex={-1}
          onKeyDown={handleMenuKeyDown}
          style={{ position: 'fixed', top: menuPos.top, left: menuPos.left, width: MENU_WIDTH }}
          // story #2998 로드맵 PR-A(L1) — floating 팝업은 --elev-overlay(오버레이 전용) 토큰으로.
          className="z-50 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-[var(--elev-overlay)]"
          onClick={(e) => e.stopPropagation()}
        >
          {onEdit && (
            <button
              role="menuitem"
              onClick={handleEdit}
              className="w-full rounded-sm px-3 py-2 text-left text-sm hover:bg-muted"
            >
              {t('editStory')}
            </button>
          )}
          {onRename && (
            <Button
              type="button"
              variant="ghost"
              role="menuitem"
              onClick={() => { closeContextMenu(false); startRename(); }}
              className={MENU_ITEM_BUTTON}
            >
              {t('renameStory')}
            </Button>
          )}
          {onChangeStatus && !locked && (
            // 4908 — 상태 바꾸기는 하위 메뉴(«상태 변경 ▸» → 항목) 대신 메뉴 안 칩 한 줄: 우클릭 → 칩 = 두 번(예전엔 세 번). 지금 상태는 ✓ + 굵기 + 테두리(색만으로 알리지 않는다) · ←/→ 로 칩 사이 이동. 잠긴(파생) 열 카드는 줄 자체가 없다(예전 «상태 변경» 항목이 없던 것과 같다).
            <div role="group" aria-label={t('changeStatus')} className="px-2 py-1.5">
              <p className="px-1 pb-1 text-micro text-muted-foreground" aria-hidden="true">{t('changeStatus')}</p>
              <div className="flex flex-wrap gap-1">
                {statuses.map((status) => {
                  const current = status.id === story.status;
                  return (
                    <Button
                      key={status.id}
                      type="button"
                      variant="ghost"
                      role="menuitemradio"
                      aria-checked={current}
                      data-status-chip={status.id}
                      onClick={() => { if (current) closeContextMenu(true); else handleChangeStatusClick(status.id); }}
                      className={cn(
                        'h-auto min-h-0 min-w-0 max-w-full gap-1 rounded-full border px-2 py-1 text-left text-xs font-normal whitespace-normal [overflow-wrap:anywhere] touch:min-h-11',
                        current ? 'border-ds-action-text bg-ds-action-soft font-semibold text-ds-ink' : 'border-ds-line hover:bg-muted',
                      )}
                    >
                      {current ? <Check className="size-3 shrink-0" strokeWidth={3} aria-hidden="true" /> : null}
                      {status.label}
                    </Button>
                  );
                })}
              </div>
            </div>
          )}
          {assignViaSubmenu ? (
            <div className="relative">
              <Button
                ref={assignTriggerRef}
                type="button"
                variant="ghost"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={assignMenuOpen}
                onClick={() => {
                  const rect = assignTriggerRef.current?.getBoundingClientRect();
                  if (rect) setAssignMenuPos({ top: clampTopToViewport(rect.top, Math.min(assignableMembers.length, 8)), left: clampToViewport(rect.right + 4) });
                  setAssignMenuOpen(!assignMenuOpen);
                }}
                className={cn(MENU_ITEM_BUTTON, 'justify-between')}
              >
                {t('assignMember')}
                <ChevronRight className="size-3.5" />
              </Button>
              {assignMenuOpen && assignMenuPos && createPortal(
                <div
                  ref={assignMenuRef}
                  role="menu"
                  tabIndex={-1}
                  onKeyDown={handleMenuKeyDown}
                  style={{ position: 'fixed', top: assignMenuPos.top, left: assignMenuPos.left, width: MENU_WIDTH }}
                  className="z-50 max-h-72 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-[var(--elev-overlay)]"
                  onClick={(e) => e.stopPropagation()}
                >
                  {assigneeChoices.map((m) => {
                    const checked = assigneeList.some((a) => a.id === m.id);
                    return (
                      <Button
                        key={m.id}
                        type="button"
                        variant="ghost"
                        role="menuitemcheckbox"
                        aria-checked={checked}
                        onClick={() => onToggleAssignee?.(story.id, m.id)}
                        className={cn(MENU_ITEM_BUTTON, 'gap-2')}
                      >
                        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{m.label}</span>
                        {checked ? <Check className="size-3.5 shrink-0 text-ds-action-text" strokeWidth={3} aria-hidden="true" /> : null}
                      </Button>
                    );
                  })}
                </div>,
                document.body,
              )}
            </div>
          ) : onAssign ? (
            <button
              role="menuitem"
              onClick={handleAssign}
              className="w-full rounded-sm px-3 py-2 text-left text-sm hover:bg-muted"
            >
              {t('assignMember')}
            </button>
          ) : null}
          {projectId && (
            // 4908 — kickoff는 예전엔 카드 호버 로켓이었다. 카드 줄 수를 줄이며 «⋯»/우클릭 메뉴로 옮겼다(같은 호출 · 같은 결과 알림).
            <button
              role="menuitem"
              disabled={triggering}
              onClick={(e) => { void handleKickoff(e); closeContextMenu(true); }}
              className="w-full rounded-sm px-3 py-2 text-left text-sm hover:bg-muted disabled:opacity-40"
            >
              {t('kickoff')}
            </button>
          )}
          {onDelete && (
            <button
              role="menuitem"
              onClick={handleDelete}
              className="w-full rounded-sm px-3 py-2 text-left text-sm text-foreground hover:bg-destructive-tint"
            >
              {t('deleteStory')}
            </button>
          )}
        </div>,
        document.body,
      )}

      <ConfirmDialog
        open={deleteConfirmOpen}
        onOpenChange={setDeleteConfirmOpen}
        title={t('deleteStoryDialogTitle')}
        description={t.rich('deleteStoryDialogBody', {
          title: story.title,
          // story #4120 — 조사를 문자열에 고정하지 않고 렌더 시점에 결정적으로 고른다.
          josa: pickEulReulJosa(story.title),
          b: (chunks) => <b className="font-semibold text-foreground">{chunks}</b>,
        })}
        cancelLabel={t('cancel')}
        confirmLabel={t('deleteStory')}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
