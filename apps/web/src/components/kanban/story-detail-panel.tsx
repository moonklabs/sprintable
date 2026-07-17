'use client';

import { useCallback, useEffect, useRef, useState, type ClipboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import { AlertTriangle, Check, GitFork, Loader2, Paperclip, Plus, Tag, Trash2, X } from 'lucide-react';
import type { KanbanStory, KanbanMember, DependencyEdge } from './types';
import type { SendAttachment } from '@/hooks/use-chat-sse';
import { getFileIcon } from '@/lib/file-icon';
import { imageFilesFromClipboard } from '@/lib/clipboard-image';
import { AttachmentImage } from '@/components/chat/attachment-image';
import { AttachmentFile } from '@/components/chat/attachment-file';
import { LabelChip, LABEL_PRESET_COLORS, type LabelData } from '@/components/ui/label-chip';
import { DependencyGraph } from './dependency-graph';
import { OutcomeResultCard, type OutcomeResult } from '@/components/outcome/outcome-result-card';
import { StoryHypothesesSection } from '@/components/hypotheses/story-hypotheses-section';
import { StoryMergeGate } from '@/components/cage/story-merge-gate';
import { EvidenceSection } from '@/components/verify/evidence-section';
import { deriveInFlightTrustChip } from '@/services/verify';
import type { ProofState } from '@/components/proof-capsule/proof-capsule';
import { Workcell, type WorkcellMessage } from '@/components/workcell/workcell';
import { initials } from '@/lib/storage/format';
import { ArtifactSection } from '@/components/canvas/artifact-section';
import { StuckHandoffSection } from '@/components/cage/stuck-handoff-section';
import { EntityDispatchPanel } from '@/components/dispatch/entity-dispatch-panel';
import { PrLinkSection } from '@/components/integrations/pr-link-section';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { COLUMNS } from './types';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { ToastContainer, useToast } from '@/components/ui/toast';
import { useSyntheticParentTabHistory } from '@/hooks/use-synthetic-parent-tab-history';

interface Task {
  id: string;
  title: string;
  status: string;
}

interface Comment {
  id: string;
  content: string;
  created_by: string;
  created_at: string;
}

interface Activity {
  id: string;
  activity_type: string;
  old_value: string | null;
  new_value: string | null;
  created_by: string;
  created_at: string;
}

interface StoryDetailPanelProps {
  story: KanbanStory;
  tasks: Task[];
  nextTasksCursor?: string | null;
  loadingMoreTasks?: boolean;
  onLoadMoreTasks?: () => void;
  onClose: () => void;
  onStoryUpdate?: (updated: KanbanStory) => void;
  onDeleteSuccess?: (storyId: string) => void;
  memberMap?: Record<string, KanbanMember>;
  members?: KanbanMember[];
  storyMap?: Record<string, { title: string; status: string }>;
  epicMap?: Record<string, string>;
  sprintMap?: Record<string, string>;
  onNavigate?: (storyId: string) => void;
  projectId?: string;
}

function taskTone(status: string) {
  if (status === 'done') return 'bg-success';
  if (status === 'in-progress') return 'bg-brand';
  return 'bg-background/20';
}

// BE _MAX_STORY_ATTACHMENTS 정합 (schemas/story.py)
const STORY_ATTACHMENT_LIMIT = 10;

function DescriptionViewer({ description }: { description: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeSanitize]}
      components={{
        p: ({ children }) => <p className="mb-2 break-words text-sm leading-6 text-muted-foreground last:mb-0">{children}</p>,
        h1: ({ children }) => <h1 className="mb-2 text-lg font-bold text-foreground">{children}</h1>,
        h2: ({ children }) => <h2 className="mb-2 text-base font-bold text-foreground">{children}</h2>,
        h3: ({ children }) => <h3 className="mb-1.5 text-sm font-bold text-foreground">{children}</h3>,
        ul: ({ children }) => <ul className="mb-2 ml-4 list-disc space-y-0.5 text-muted-foreground">{children}</ul>,
        ol: ({ children }) => <ol className="mb-2 ml-4 list-decimal space-y-0.5 text-muted-foreground">{children}</ol>,
        li: ({ children }) => <li className="text-sm leading-6">{children}</li>,
        pre: ({ children }) => <pre className="mb-2 overflow-x-auto rounded-lg bg-muted p-3 text-[13px] text-foreground">{children}</pre>,
        code: ({ children }) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-[13px] text-foreground">{children}</code>,
        blockquote: ({ children }) => <blockquote className="mb-2 border-l-2 border-border pl-3 text-muted-foreground">{children}</blockquote>,
        a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">{children}</a>,
        strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
        em: ({ children }) => <em className="italic text-muted-foreground">{children}</em>,
        hr: () => <hr className="my-2 border-border" />,
      }}
    >
      {description}
    </ReactMarkdown>
  );
}

export function StoryDetailPanel({ story, tasks, nextTasksCursor = null, loadingMoreTasks = false, onLoadMoreTasks, onClose, onStoryUpdate, onDeleteSuccess, memberMap = {}, members = [], storyMap = {}, epicMap = {}, sprintMap = {}, onNavigate, projectId }: StoryDetailPanelProps) {
  const t = useTranslations('board');
  // story #1959(P2-S3): 딥링크 매니페스트(story_detail→parentTab=all) — 콜드 진입 시 "전체"
  // 탭 루트를 BACK 대상으로 선주입. 카드 클릭으로 연 경우(history.length>1)는 no-op.
  useSyntheticParentTabHistory('/more');
  const { toasts, addToast, dismissToast } = useToast();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [comments, setComments] = useState<Comment[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [nextCommentsCursor, setNextCommentsCursor] = useState<string | null>(null);
  const [nextActivitiesCursor, setNextActivitiesCursor] = useState<string | null>(null);
  const [loadingComments, setLoadingComments] = useState(false);
  const [loadingActivities, setLoadingActivities] = useState(false);
  const [loadingMoreComments, setLoadingMoreComments] = useState(false);
  const [loadingMoreActivities, setLoadingMoreActivities] = useState(false);
  const [commentInput, setCommentInput] = useState('');
  const [submittingComment, setSubmittingComment] = useState(false);
  const [expandedActivityId, setExpandedActivityId] = useState<string | null>(null);

  // Edit state
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(story.title);
  const [savingTitle, setSavingTitle] = useState(false);
  const [savingStatus, setSavingStatus] = useState(false);
  const [localStatus, setLocalStatus] = useState(story.status);

  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState(story.description ?? '');
  const [savingDescription, setSavingDescription] = useState(false);
  const [editingAC, setEditingAC] = useState(false);
  const [acDraft, setAcDraft] = useState(story.acceptance_criteria ?? '');
  const [savingAC, setSavingAC] = useState(false);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const [attachError, setAttachError] = useState(false);
  const attachInputRef = useRef<HTMLInputElement>(null);

  const [editingAssignee, setEditingAssignee] = useState(false);
  // E-BOARD: assignee optimistic local state — mirrors localStatus (L130). Checkmark/collapsed
  // render read this, so a click reflects immediately instead of waiting for the PATCH round-trip
  // + parent `onStoryUpdate` prop push. Decoupling from the `story` prop is what fixes "됐다 안됐다".
  const [localAssigneeIds, setLocalAssigneeIds] = useState<string[]>(() =>
    story.assignee_ids && story.assignee_ids.length > 0
      ? story.assignee_ids
      : story.assignee_id ? [story.assignee_id] : []
  );
  // 연타 race 가드: 옵티미스틱 토글의 source-of-truth. 클릭마다 동기 갱신해 같은 틱 더블클릭에서도
  // 직전 stale snapshot이 아닌 최신값 기준으로 next를 계산(함수형 업데이트와 동등한 보장).
  const assigneeIdsRef = useRef<string[]>(localAssigneeIds);

  const [deps, setDeps] = useState<DependencyEdge[]>([]);
  const [loadingDeps, setLoadingDeps] = useState(false);
  // P0-04(trust-pipeline-minimal-decision) — in-flight 전용 신뢰 칩. gate_type/status/
  // neutral_facts.ci_result만 필요(GateItem 전체 불요) — 얇은 로컬 타입으로 충분.
  const [chipGates, setChipGates] = useState<{ gate_type: string; status: string; neutral_facts?: Record<string, unknown> | null }[]>([]);
  const [showAddDep, setShowAddDep] = useState(false);
  const [depQuery, setDepQuery] = useState('');
  const [depQueryResults, setDepQueryResults] = useState<{ id: string; title: string }[]>([]);
  const [depType, setDepType] = useState<'blocks' | 'depends_on'>('blocks');
  const [addingDep, setAddingDep] = useState(false);

  const [storyLabels, setStoryLabels] = useState<(LabelData & { itemLabelId: string })[]>([]);
  const [orgLabels, setOrgLabels] = useState<LabelData[]>([]);
  const [loadingLabels, setLoadingLabels] = useState(false);
  const [showLabelPicker, setShowLabelPicker] = useState(false);
  const [newLabelName, setNewLabelName] = useState('');
  const [newLabelColor, setNewLabelColor] = useState<string>(LABEL_PRESET_COLORS[0]);
  const [creatingLabel, setCreatingLabel] = useState(false);

  const handleDelete = useCallback(async () => {
    setDeleting(true);
    try {
      const res = await fetch(`/api/stories/${story.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const json = await res.json().catch(() => null) as { error?: { message?: string } } | null;
        addToast({ type: 'error', title: json?.error?.message ?? '스토리 삭제에 실패했습니다.' });
        return;
      }
      onDeleteSuccess?.(story.id);
      onClose();
    } catch {
      addToast({ type: 'error', title: '스토리 삭제에 실패했습니다.' });
    } finally {
      setDeleting(false);
      setShowDeleteConfirm(false);
    }
  }, [story.id, onDeleteSuccess, onClose, addToast]);

  const titleInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTitleDraft(story.title);
    setDescriptionDraft(story.description ?? '');
    setAcDraft(story.acceptance_criteria ?? '');
  }, [story.id, story.title, story.description, story.acceptance_criteria]);

  useEffect(() => {
    if (editingTitle) {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    }
  }, [editingTitle]);

  useEffect(() => {
    setLoadingLabels(true);
    Promise.all([
      fetch(`/api/item-labels?item_type=story&item_id=${story.id}`).then((r) => r.ok ? r.json() : []),
      fetch('/api/labels').then((r) => r.ok ? r.json() : []),
    ])
      .then(([itemLabels, allLabels]) => {
        const all = allLabels as LabelData[];
        setOrgLabels(all);
        const labelMap = Object.fromEntries(all.map((l) => [l.id, l]));
        const attached = (itemLabels as { id: string; label_id: string }[]).map((il) => ({
          ...(labelMap[il.label_id] ?? { id: il.label_id, name: il.label_id.slice(0, 6), color: null }),
          itemLabelId: il.id,
        }));
        setStoryLabels(attached);
      })
      .catch(() => {})
      .finally(() => setLoadingLabels(false));
  }, [story.id]);

  const handleAttachLabel = async (labelId: string) => {
    if (storyLabels.some((l) => l.id === labelId)) return;
    const res = await fetch('/api/item-labels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label_id: labelId, item_id: story.id, item_type: 'story' }),
    });
    if (res.ok) {
      const il = await res.json() as { id: string; label_id: string };
      const label = orgLabels.find((l) => l.id === labelId);
      if (label) setStoryLabels((prev) => [...prev, { ...label, itemLabelId: il.id }]);
    }
  };

  const handleDetachLabel = async (itemLabelId: string) => {
    const res = await fetch(`/api/item-labels/${itemLabelId}`, { method: 'DELETE' });
    if (res.ok) setStoryLabels((prev) => prev.filter((l) => l.itemLabelId !== itemLabelId));
  };

  const handleCreateLabel = async () => {
    if (!newLabelName.trim()) return;
    setCreatingLabel(true);
    try {
      const res = await fetch('/api/labels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newLabelName.trim(), color: newLabelColor }),
      });
      if (res.ok) {
        const newLabel = await res.json() as LabelData;
        setOrgLabels((prev) => [...prev, newLabel]);
        setNewLabelName('');
        await handleAttachLabel(newLabel.id);
      }
    } finally {
      setCreatingLabel(false);
    }
  };

  useEffect(() => {
    if (!depQuery.trim() || depQuery.length < 2) { setDepQueryResults([]); return; }
    const tid = setTimeout(() => {
      const params = new URLSearchParams({ q: depQuery });
      if (projectId) params.set('project_id', projectId);
      fetch(`/api/stories?${params}`)
        .then((r) => r.ok ? r.json() : null)
        .then((json) => {
          const results = (json?.data ?? []) as { id: string; title: string }[];
          setDepQueryResults(results.filter((s) => s.id !== story.id).slice(0, 6));
        })
        .catch(() => {});
    }, 300);
    return () => clearTimeout(tid);
  }, [depQuery, story.id, projectId]);

  const handleAddDep = async (targetId: string) => {
    setAddingDep(true);
    try {
      const res = await fetch('/api/dependencies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from_id: story.id, to_id: targetId, dep_type: depType, item_type: 'story' }),
      });
      if (res.ok) {
        const dep = await res.json() as DependencyEdge;
        setDeps((prev) => [...prev, dep]);
        setDepQuery('');
        setDepQueryResults([]);
        setShowAddDep(false);
      } else if (res.status === 409) {
        addToast({ type: 'warning', title: t('dep.duplicateConnection') });
      } else if (res.status === 422) {
        const json = await res.json().catch(() => null) as { detail?: string } | null;
        addToast({ type: 'error', title: json?.detail?.includes('사이클') ? t('dep.cycleDetected') : t('dep.invalidSelf') });
      } else {
        addToast({ type: 'error', title: t('dep.addFailed') });
      }
    } catch {
      addToast({ type: 'error', title: t('dep.addFailed') });
    } finally {
      setAddingDep(false);
    }
  };

  const handleRemoveDep = async (depId: string) => {
    const res = await fetch(`/api/dependencies/${depId}`, { method: 'DELETE' });
    if (res.ok) setDeps((prev) => prev.filter((d) => d.id !== depId));
  };

  useEffect(() => {
    setLoadingDeps(true);
    fetch(`/api/dependencies?item_type=story&item_id=${story.id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        const raw = Array.isArray(json) ? json : [];
        setDeps(raw as DependencyEdge[]);
      })
      .catch(() => {})
      .finally(() => setLoadingDeps(false));
  }, [story.id]);

  // P0-04 in-flight 신뢰 칩 — StoryMergeGate와 동형 데이터소스(work_item_id 필터, BE 추가 0).
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/gates?work_item_id=${story.id}&work_item_type=story`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : []))
      .then((gates) => { if (!cancelled) setChipGates(Array.isArray(gates) ? gates : []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [story.id]);

  // Keep the locally-displayed status synced when a different story is selected or the
  // board pushes an external update. Optimistic in-panel changes set it directly (handler),
  // so the badge reflects immediately without waiting for the prop round-trip (S6 AC2 ④).
  useEffect(() => { setLocalStatus(story.status); }, [story.status]);

  const statusKeyMap: Record<string, 'backlog' | 'readyForDev' | 'inProgress' | 'inReview' | 'done'> = {
    backlog: 'backlog',
    'ready-for-dev': 'readyForDev',
    'in-progress': 'inProgress',
    'in-review': 'inReview',
    done: 'done',
  };
  const statusKey = statusKeyMap[localStatus];
  const statusLabel = statusKey ? t(statusKey) : localStatus;

  // P0-04(trust-pipeline-minimal-decision) — in-flight 전용 칩. done엔 항상 무표시(TrustSeal
  // 담당·중복 금지, deriveInFlightTrustChip 내부에서 강제). 무신호=칩 자체 미렌더(no-fiction).
  const trustChip = deriveInFlightTrustChip(localStatus, chipGates);
  const trustChipLabel = trustChip === 'needs_input' ? t('trustChipNeedsInput') : trustChip === 'merge_ready' ? t('trustChipMergeReady') : null;

  // E-UI-DAEGBYEON P0 — Workcell 최소 실화면 배선(story `e5310d1b`, dead-path 방지).
  // 정직한 최소 표면: 실 필드(title/status/assignee/description/acceptance_criteria/
  // blocked_by/comments)만으로 채울 수 있는 것만 채운다 — 없는 값은 허구로 안 채움:
  // - Run.now/stage는 story.status(coarse) 이상의 세부 행위 신호가 없어 statusLabel 그대로
  //   사용(과장 없음). tools/scopes는 실 데이터 없어 빈 배열(빈 배열=정직, 조작 아님).
  // - Evidence는 ProofCapsuleProps 실 매핑 인프라(EvidenceSection 재사용)가 후속 스코프라
  //   지금은 null(정직한 "아직 증거 없음" — 스펙이 명시적으로 허용하는 케이스).
  // - human assignee 없으면 Workcell 렌더 자체를 생략(허구 human 금지, ProofCapsule 배선과 동일 규율).
  // P0-04 그라운딩(2026-07-11): GET /api/v2/agent-runs가 story_id 필터를 지원하지 않아(BE
  // AgentRunRepository.list()는 project_id/agent_id만 필터) FE가 "지금 실제로 도는 에이전트가
  // 있는지" 알 방법이 없다. 종전엔 blue 상태에 공용 "실행 중"(proofCapsuleStateRunning) 라벨을
  // 썼는데, 이는 story.status='in-progress'라는 coarse 신호를 "에이전트가 지금 실행 중"이라는
  // 더 구체적인 주장으로 과장한 것 — no-fiction 위반(파운더 독트린: 실시간 이벤트 텍스트≠실
  // 실시간 신호). Workcell 전용으로 "진행 중"(workcellStateInProgress, 순수 status 반영, 실행
  // 주장 없음)으로 정정. Board/Audit의 공용 blue="실행 중" 라벨은 별개 표면이라 스코프 밖
  // (그쪽도 같은 근본 갭이 있으면 후속 별도 판단). 실 AgentRun story_id 필터는 디디 BE 티켓.
  const PROOF_STATE_BY_STATUS: Record<string, ProofState> = {
    'in-progress': 'blue', 'in-review': 'amber', done: 'green',
  };
  const proofState = PROOF_STATE_BY_STATUS[localStatus];
  const proofStateLabel = proofState
    ? { blue: t('workcellStateInProgress'), amber: t('proofCapsuleStateReviewing'), green: t('proofCapsuleStateProven'), red: t('proofCapsuleStateViolation') }[proofState]
    : null;
  const assigneeIds = story.assignee_ids?.length ? story.assignee_ids : (story.assignee_id ? [story.assignee_id] : []);
  const proofHumanId = assigneeIds.find((id) => memberMap[id] && memberMap[id]!.type !== 'agent');
  const proofAgentId = assigneeIds.find((id) => memberMap[id]?.type === 'agent');
  const proofHuman = proofHumanId ? memberMap[proofHumanId] : null;
  const proofAgent = proofAgentId ? memberMap[proofAgentId] : null;

  const WORKCELL_NEXT_NEED_BY_STATUS: Record<string, string> = {
    'in-progress': t('workcellNextNeedInProgress'),
    'in-review': t('workcellNextNeedInReview'),
    done: t('workcellNextNeedDone'),
  };
  const workcellMessages: WorkcellMessage[] = comments.map((c) => ({
    author: memberMap[c.created_by]?.name ?? c.created_by,
    body: c.content,
  }));

  const patchStory = async (body: Record<string, unknown>): Promise<KanbanStory | null> => {
    const res = await fetch(`/api/stories/${story.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.data as KanbanStory;
  };

  const handleChangeStatus = async (newStatus: string) => {
    if (newStatus === localStatus || savingStatus) return;
    const prev = localStatus;
    setSavingStatus(true);
    setLocalStatus(newStatus); // optimistic — badge reflects immediately (local, no prop round-trip)
    // The dedicated status endpoint runs the state-machine validation + events; the general
    // /stories/{id} PATCH (patchStory) intentionally omits `status`, so it would 200 without
    // persisting — the root of the badge reverting after a "successful" change.
    let ok = false;
    let violation: unknown = null;
    try {
      const res = await fetch(`/api/stories/${story.id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      ok = res.ok;
      if (ok) {
        const json = await res.json().catch(() => null) as { data?: { violation?: unknown } } | null;
        violation = json?.data?.violation ?? null;
      }
    } catch { /* network error — treat as failure, roll back below */ }
    setSavingStatus(false);
    if (ok) {
      onStoryUpdate?.({ ...story, status: newStatus }); // persisted → sync the board
      // 정공법 A(c1cd484b): 비순차 점프는 BE가 violation(warn)으로 기록·차단X → 비차단 인디케이터(보드와 일관).
      if (violation) addToast({ type: 'warning', title: t('transitionViolation') });
    } else {
      setLocalStatus(prev); // BE rejected (권한 등) — roll back
    }
  };

  const handleSaveTitle = async () => {
    if (!titleDraft.trim() || titleDraft === story.title) {
      setEditingTitle(false);
      return;
    }
    setSavingTitle(true);
    const updated = await patchStory({ title: titleDraft.trim() });
    setSavingTitle(false);
    setEditingTitle(false);
    if (updated) onStoryUpdate?.({ ...story, title: updated.title });
  };

  // E-BOARD S6: 복수 assignee. assignee_ids 우선, 없으면 단일 assignee_id로 폴백(하위호환).
  const currentAssigneeIds = (story.assignee_ids && story.assignee_ids.length > 0)
    ? story.assignee_ids
    : (story.assignee_id ? [story.assignee_id] : []);

  // prop이 바뀌면(네비게이션·외부 갱신·dispatch 패널 onAssigneePatched 경로) 로컬을 재동기화 — localStatus(L319) 미러.
  // 배열 ref가 아닌 내용(join) 기준 → 부모 리렌더가 in-flight 옵티미스틱 값을 덮지 않음.
  const assigneeSyncKey = currentAssigneeIds.join(',');
  useEffect(() => {
    assigneeIdsRef.current = currentAssigneeIds;
    setLocalAssigneeIds(currentAssigneeIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assigneeSyncKey]);

  const handleToggleAssignee = async (memberId: string) => {
    const prev = assigneeIdsRef.current;
    const next = prev.includes(memberId)
      ? prev.filter((id) => id !== memberId)
      : [...prev, memberId];
    assigneeIdsRef.current = next;   // 동기 갱신 → 연타 시 다음 클릭이 최신 기준으로 계산
    setLocalAssigneeIds(next);       // 옵티미스틱 — 체크마크/표시 즉시 반영
    // assignee_ids 전체 배열 교체(서버 last-write-wins) → 연타 시 마지막 로컬과 정합.
    const updated = await patchStory({ assignee_ids: next });
    if (updated) {
      // BE가 assignee_id(주담당)를 assignee_ids[0]로 동기화 → 응답 우선, 없으면 로컬 계산.
      const resolved = updated.assignee_ids ?? next;
      assigneeIdsRef.current = resolved;
      setLocalAssigneeIds(resolved);
      onStoryUpdate?.({ ...story, assignee_ids: resolved, assignee_id: updated.assignee_id ?? resolved[0] ?? null });
    } else {
      assigneeIdsRef.current = prev; // PATCH 실패 → 직전 값 롤백
      setLocalAssigneeIds(prev);
      addToast({ type: 'error', title: '담당자 변경에 실패했습니다.' });
    }
  };

  const handleClearAssignees = async () => {
    const prev = assigneeIdsRef.current;
    assigneeIdsRef.current = [];
    setLocalAssigneeIds([]);         // 옵티미스틱
    setEditingAssignee(false);
    const updated = await patchStory({ assignee_ids: [] });
    if (updated) {
      onStoryUpdate?.({ ...story, assignee_ids: [], assignee_id: null });
    } else {
      assigneeIdsRef.current = prev; // 롤백
      setLocalAssigneeIds(prev);
      addToast({ type: 'error', title: '담당자 변경에 실패했습니다.' });
    }
  };

  const handleSaveDescription = async () => {
    if (descriptionDraft === (story.description ?? '')) {
      setEditingDescription(false);
      return;
    }
    setSavingDescription(true);
    const updated = await patchStory({ description: descriptionDraft || null });
    setSavingDescription(false);
    setEditingDescription(false);
    if (updated) onStoryUpdate?.({ ...story, description: updated.description });
  };

  const handleSaveAC = async () => {
    if (acDraft === (story.acceptance_criteria ?? '')) {
      setEditingAC(false);
      return;
    }
    setSavingAC(true);
    const updated = await patchStory({ acceptance_criteria: acDraft || null });
    setSavingAC(false);
    setEditingAC(false);
    if (updated) onStoryUpdate?.({ ...story, acceptance_criteria: updated.acceptance_criteria });
  };

  // E-FILE S4: 스토리 첨부 — GCS 업로드 후 PATCH {attachments} (전체 교체이므로 기존+신규 머지 필수).
  const handleAttachFiles = async (files: File[]) => {
    if (files.length === 0 || uploadingAttachment) return;
    const current = story.attachments ?? [];
    const room = STORY_ATTACHMENT_LIMIT - current.length;
    if (room <= 0) return;
    setUploadingAttachment(true);
    setAttachError(false);
    try {
      const uploaded: SendAttachment[] = [];
      for (const file of files.slice(0, room)) {
        const fd = new FormData();
        fd.append('file', file);
        // 03fe1663: project_id는 업로드 라우트가 story에서 server-side 도출(클라이언트 전달 불요).
        const res = await fetch(`/api/stories/${story.id}/attachments`, { method: 'POST', body: fd });
        if (!res.ok) throw new Error('upload failed');
        uploaded.push(await res.json() as SendAttachment);
      }
      const next = [...current, ...uploaded]; // 전체 교체: 기존 보존 + 신규 누적
      const updated = await patchStory({ attachments: next });
      onStoryUpdate?.({ ...story, attachments: updated?.attachments ?? next });
    } catch {
      setAttachError(true);
    } finally {
      setUploadingAttachment(false);
    }
  };

  // S3: paste an image while editing a story → upload as an attachment (same path as the
  // file picker). Non-image pastes fall through to normal textarea paste.
  const handlePasteAttach = (e: ClipboardEvent) => {
    const images = imageFilesFromClipboard(e);
    if (images.length > 0) {
      e.preventDefault();
      void handleAttachFiles(images);
    }
  };

  const handleRemoveAttachment = async (url: string) => {
    const next = (story.attachments ?? []).filter((a) => a.url !== url); // filter → 전체 교체
    const updated = await patchStory({ attachments: next });
    onStoryUpdate?.({ ...story, attachments: updated?.attachments ?? next });
  };

  // Fetch comments
  useEffect(() => {
    async function fetchComments() {
      setLoadingComments(true);
      try {
        const res = await fetch(`/api/stories/${story.id}/comments?limit=20`);
        if (res.ok) {
          const json = await res.json();
          setComments(json.data ?? []);
          setNextCommentsCursor(json.meta?.nextCursor ?? null);
        }
      } catch {
        setComments([]);
      } finally {
        setLoadingComments(false);
      }
    }
    void fetchComments();
  }, [story.id]);

  // Fetch activities
  useEffect(() => {
    async function fetchActivities() {
      setLoadingActivities(true);
      try {
        const res = await fetch(`/api/stories/${story.id}/activities?limit=20`);
        if (res.ok) {
          const json = await res.json();
          setActivities(json.data ?? []);
          setNextActivitiesCursor(json.meta?.nextCursor ?? null);
        }
      } catch {
        setActivities([]);
      } finally {
        setLoadingActivities(false);
      }
    }
    void fetchActivities();
  }, [story.id]);

  // ESC 키로 닫기
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (editingTitle) { setEditingTitle(false); setTitleDraft(story.title); return; }
        if (editingDescription) { setEditingDescription(false); setDescriptionDraft(story.description ?? ''); return; }
        if (editingAC) { setEditingAC(false); setAcDraft(story.acceptance_criteria ?? ''); return; }
        onClose();
      }
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [onClose, editingTitle, editingDescription, editingAC, story.title, story.description, story.acceptance_criteria]);

  const handleSubmitComment = async () => {
    if (!commentInput.trim() || submittingComment) return;

    setSubmittingComment(true);
    try {
      const res = await fetch(`/api/stories/${story.id}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: commentInput }),
      });

      if (res.ok) {
        const json = await res.json();
        setComments((prev) => [json.data, ...prev]);
        setCommentInput('');
      }
    } catch {
      // silent
    } finally {
      setSubmittingComment(false);
    }
  };

  const handleLoadMoreComments = async () => {
    if (!nextCommentsCursor || loadingMoreComments) return;

    setLoadingMoreComments(true);
    try {
      const res = await fetch(`/api/stories/${story.id}/comments?limit=20&cursor=${encodeURIComponent(nextCommentsCursor)}`);
      if (res.ok) {
        const json = await res.json();
        setComments((prev) => [...prev, ...(json.data ?? [])]);
        setNextCommentsCursor(json.meta?.nextCursor ?? null);
      }
    } finally {
      setLoadingMoreComments(false);
    }
  };

  const handleLoadMoreActivities = async () => {
    if (!nextActivitiesCursor || loadingMoreActivities) return;

    setLoadingMoreActivities(true);
    try {
      const res = await fetch(`/api/stories/${story.id}/activities?limit=20&cursor=${encodeURIComponent(nextActivitiesCursor)}`);
      if (res.ok) {
        const json = await res.json();
        setActivities((prev) => [...prev, ...(json.data ?? [])]);
        setNextActivitiesCursor(json.meta?.nextCursor ?? null);
      }
    } finally {
      setLoadingMoreActivities(false);
    }
  };

  // E-BOARD S4: Activity 상세화 — old→new resolve(UUID 노출 0)·화살표. 긴 값은 expanded 시 전체 표시.
  const truncate = (v: string, n = 40) => (v.length > n ? `${v.slice(0, n)}…` : v);
  const renderChange = (oldLabel: string | null, newLabel: string, expand: boolean): React.ReactNode => (
    <span className="inline-flex flex-wrap items-center gap-1 align-middle">
      {oldLabel != null ? (
        <>
          <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground line-through">{expand ? oldLabel : truncate(oldLabel)}</span>
          <span className="text-muted-foreground">→</span>
        </>
      ) : null}
      <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-foreground">{expand ? newLabel : truncate(newLabel)}</span>
    </span>
  );
  const memberName = (id: string | null) => (id ? (memberMap[id]?.name ?? '—') : '—');
  const epicName = (id: string | null) => (id ? (epicMap[id] ?? '—') : '—');
  const sprintName = (id: string | null) => (id ? (sprintMap[id] ?? '—') : '—');

  const formatActivityMessage = (activity: Activity, expand: boolean): React.ReactNode => {
    const { activity_type, old_value, new_value } = activity;
    switch (activity_type) {
      case 'created':
        return <span className="text-foreground">Created{new_value ? <>: <span className="font-medium">{expand ? new_value : truncate(new_value)}</span></> : null}</span>;
      case 'status_changed':
        return <span className="text-foreground">Status {renderChange(old_value, new_value ?? '—', expand)}</span>;
      case 'assignee_changed':
        return <span className="text-foreground">Assignee {renderChange(old_value ? memberName(old_value) : null, memberName(new_value), expand)}</span>;
      case 'title_changed':
        return <span className="text-foreground">Title {renderChange(old_value, new_value ?? '—', expand)}</span>;
      case 'epic_changed':
        return <span className="text-foreground">Epic {renderChange(old_value ? epicName(old_value) : null, epicName(new_value), expand)}</span>;
      case 'sprint_changed':
        return <span className="text-foreground">Sprint {renderChange(old_value ? sprintName(old_value) : null, sprintName(new_value), expand)}</span>;
      default:
        return <span className="text-foreground">{activity_type}</span>;
    }
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-overlay-backdrop backdrop-blur-sm lg:bg-transparent"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="fixed inset-0 z-50 bg-background shadow-xl backdrop-blur-xl lg:inset-y-0 lg:left-auto lg:right-0 lg:w-full lg:max-w-3xl lg:border-l lg:border-border">
      <div className="flex h-full flex-col">
        <div className="flex items-start justify-between border-b border-border p-5">
          <div className="flex-1 space-y-2 pr-3">
            {story.story_number ? (
              <span className="block text-xs font-medium text-muted-foreground">#{story.story_number}</span>
            ) : null}
            {editingTitle ? (
              <div className="space-y-2">
                <input
                  ref={titleInputRef}
                  type="text"
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleSaveTitle();
                  }}
                  className="w-full rounded-md border border-border bg-muted px-2 py-1 text-lg font-semibold text-foreground outline-none focus:ring-2 focus:ring-primary"
                />
                <div className="flex gap-2">
                  <Button size="sm" onClick={handleSaveTitle} disabled={savingTitle || !titleDraft.trim()}>
                    {savingTitle ? t('loading') : t('save')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => { setEditingTitle(false); setTitleDraft(story.title); }}>
                    {t('cancel')}
                  </Button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="group flex w-full items-start gap-1 text-left"
                onClick={() => setEditingTitle(true)}
              >
                <h2 className="text-lg font-semibold text-foreground">{story.title}</h2>
                <span className="mt-1 shrink-0 text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">✎</span>
              </button>
            )}
            <div className="flex items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <button type="button" disabled={savingStatus} aria-label={t('status')}>
                      <StatusBadge status={localStatus} label={statusLabel} interactive />
                    </button>
                  }
                />
                <DropdownMenuContent align="start">
                  {COLUMNS.map((col) => {
                    const isCurrent = col.id === localStatus;
                    // 정공법 A(c1cd484b): 전이-순서 disable 제거 — 어느 상태로든 선택 가능(하드블록 X).
                    // 비정상 점프는 /status 응답 violation → 비차단 토스트로 가시화.
                    return (
                      <DropdownMenuItem
                        key={col.id}
                        disabled={savingStatus || isCurrent}
                        onClick={() => { if (!isCurrent) void handleChangeStatus(col.id); }}
                      >
                        <Check className={`size-4 ${isCurrent ? '' : 'opacity-0'}`} />
                        {t(statusKeyMap[col.id] ?? col.i18nKey)}
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
              {/* P0-04(trust-pipeline-minimal-decision) — in-flight 전용 신뢰 칩(입력 필요/병합
                  대기). done엔 렌더 0(TrustSeal 중복 방지)·무신호(gate 없음)면 칩 자체 미렌더. 5-status
                  배지는 무변경(순수 additive 오버레이). 칸반 카드엔 안 얹음(Proofline이 이미 담당). */}
              {trustChip && trustChipLabel ? (
                <span
                  className={
                    trustChip === 'merge_ready'
                      ? 'inline-flex items-center gap-1.5 rounded-[7px] bg-proof-green-soft px-2 py-0.5 text-[11px] font-semibold text-proof-green'
                      : 'inline-flex items-center gap-1.5 rounded-[7px] bg-proof-amber-soft px-2 py-0.5 text-[11px] font-semibold text-proof-amber'
                  }
                >
                  <span className={`size-1.5 rounded-full ${trustChip === 'merge_ready' ? 'bg-proof-green' : 'bg-proof-amber'}`} aria-hidden="true" />
                  {trustChipLabel}
                </span>
              ) : null}
            </div>
            {/* E-VERIFY V0-S3 Lv1/Lv2 + P0-04 Claimed-vs-Verified — 완료 badge의 연장으로 읽히도록
                바로 아래. 증거 0이면 EvidenceSection 자체가 null 렌더(행 미노출, §7 상태 매트릭스). */}
            <EvidenceSection
              workItemId={story.id}
              workItemType="story"
              selfReported={story.self_reported}
              humanVerified={story.human_verified}
              humanVerifiedBy={story.human_verified_by}
              humanVerifiedAt={story.human_verified_at}
              memberMap={memberMap}
            />
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setShowDeleteConfirm(true)}
              className="flex items-center gap-1 rounded-md border border-destructive/40 px-2.5 py-1.5 text-xs text-destructive transition hover:bg-destructive/10"
              aria-label={t('deleteStory')}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
            <button type="button" onClick={onClose} className="rounded-md border border-border px-3 py-2 text-muted-foreground transition hover:text-foreground hover:bg-muted/50">✕</button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          <div className="space-y-5">
            {/* E-UI-DAEGBYEON P0 — Workcell 4층 데뷔(최소 실화면 배선, story `e5310d1b`).
                Evidence는 null(정직한 "아직 증거 없음" — EvidenceSection/StoryMergeGate 실
                데이터 매핑은 후속 스코프, 대체 아님). human assignee 없으면 전체 생략. */}
            {proofState && proofStateLabel && proofHuman ? (
              <Workcell
                title={story.title}
                proofState={proofState}
                stateLabel={proofStateLabel}
                brief={{
                  goal: story.description?.trim() || story.title,
                  dod: story.acceptance_criteria?.trim() || t('workcellDodMissing'),
                  owner: { name: proofHuman.name, role: 'human' },
                  agent: proofAgent ? { name: proofAgent.name, initial: initials(proofAgent.name) } : undefined,
                }}
                run={{
                  now: statusLabel,
                  stage: statusLabel,
                  tools: [],
                  scopes: [],
                  blocked: story.blocked_by?.length ? t('workcellBlockedReason') : null,
                  nextNeed: WORKCELL_NEXT_NEED_BY_STATUS[localStatus] ?? statusLabel,
                }}
                evidence={null}
                conversation={{ view: 'run', messages: workcellMessages }}
              />
            ) : null}
            <div>
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">{t('assignee')}</span>
                {!editingAssignee && (
                  <button
                    type="button"
                    onClick={() => setEditingAssignee(true)}
                    className="text-xs text-muted-foreground transition hover:text-foreground"
                  >
                    ✎ {t('edit')}
                  </button>
                )}
              </div>
              {editingAssignee ? (
                <div className="mt-1 flex flex-col gap-1 rounded-md border border-border bg-muted/30 p-1">
                  <button
                    type="button"
                    onClick={() => void handleClearAssignees()}
                    className="w-full rounded px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted"
                  >
                    — {t('clearAssignees')}
                  </button>
                  {members.filter((m, i, arr) => arr.findIndex((x) => x.id === m.id) === i).map((m) => {
                    const selected = localAssigneeIds.includes(m.id);
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => void handleToggleAssignee(m.id)}
                        className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted ${selected ? 'font-medium text-foreground' : 'text-muted-foreground'}`}
                      >
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-foreground">
                          {m.name.slice(0, 2).toUpperCase()}
                        </span>
                        {m.name}
                        {selected && <span className="ml-auto text-primary">✓</span>}
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    onClick={() => setEditingAssignee(false)}
                    className="mt-1 w-full rounded px-2 py-1 text-center text-xs text-muted-foreground hover:bg-muted"
                  >
                    {t('cancel')}
                  </button>
                </div>
              ) : (
                <p className="mt-1 text-sm text-foreground">
                  {localAssigneeIds.length > 0
                    ? localAssigneeIds.map((id) => memberMap[id]?.name ?? '—').join(', ')
                    : '—'}
                </p>
              )}
            </div>

            {/* E-BOARD S1: Dispatch — assignee 인접(킥오프=assignee 선택 후 액션). EntityDispatchPanel 마운트만(신규 디자인 0). */}
            {projectId && (
              <div className="rounded-lg border border-border bg-muted/20 p-3">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Dispatch</p>
                <EntityDispatchPanel
                  entityType="story"
                  entityId={story.id}
                  projectId={projectId}
                  currentAssigneeId={localAssigneeIds.length > 1 ? undefined : (localAssigneeIds[0] ?? story.assignee_id)}
                  onAssigneePatched={(aid) => onStoryUpdate?.({ ...story, assignee_id: aid })}
                />
              </div>
            )}

            {/* E-DG S12: handoff stuck UX — DISPATCH 직후·handoff_stuck일 때만 조건부 렌더(자체 게이트) */}
            <StuckHandoffSection storyId={story.id} memberMap={memberMap} />

            {story.story_points != null ? (
              <div>
                <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">{t('storyPoints')}</span>
                <p className="mt-1 text-sm text-foreground">{t('storyPointsBadge', { count: story.story_points })}</p>
              </div>
            ) : null}

            {/* Description */}
            <div>
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">{t('description')}</span>
                {!editingDescription && (
                  <button
                    type="button"
                    onClick={() => setEditingDescription(true)}
                    className="text-xs text-muted-foreground transition hover:text-foreground"
                  >
                    ✎ {t('edit')}
                  </button>
                )}
              </div>
              {editingDescription ? (
                <div className="mt-2 space-y-2">
                  <textarea
                    value={descriptionDraft}
                    onChange={(e) => setDescriptionDraft(e.target.value)}
                    onPaste={handlePasteAttach}
                    placeholder="Markdown 형식으로 작성하세요..."
                    className="flex field-sizing-content min-h-[160px] w-full resize-y rounded-lg border border-input bg-transparent px-2.5 py-2 font-mono text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                    autoFocus
                  />
                  <div className="flex gap-2">
                    <Button size="sm" onClick={handleSaveDescription} disabled={savingDescription}>
                      {savingDescription ? t('loading') : t('save')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => { setEditingDescription(false); setDescriptionDraft(story.description ?? ''); }}>
                      {t('cancel')}
                    </Button>
                  </div>
                </div>
              ) : story.description ? (
                <div className="mt-2 cursor-pointer" onClick={() => setEditingDescription(true)}>
                  <DescriptionViewer description={story.description} />
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setEditingDescription(true)}
                  className="mt-2 w-full rounded-md border border-dashed border-border py-3 text-sm text-muted-foreground transition hover:border-primary hover:text-primary"
                >
                  + {t('addDescription')}
                </button>
              )}
            </div>

            {/* Acceptance Criteria — Description 블록 미러 (E-BOARD-UX S3) */}
            <div>
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">{t('acceptanceCriteria')}</span>
                {!editingAC && (
                  <button
                    type="button"
                    onClick={() => setEditingAC(true)}
                    className="text-xs text-muted-foreground transition hover:text-foreground"
                  >
                    ✎ {t('edit')}
                  </button>
                )}
              </div>
              {editingAC ? (
                <div className="mt-2 space-y-2">
                  <textarea
                    value={acDraft}
                    onChange={(e) => setAcDraft(e.target.value)}
                    placeholder="Markdown 형식으로 작성하세요..."
                    className="flex field-sizing-content min-h-[160px] w-full resize-y rounded-lg border border-input bg-transparent px-2.5 py-2 font-mono text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                    autoFocus
                  />
                  <div className="flex gap-2">
                    <Button size="sm" onClick={handleSaveAC} disabled={savingAC}>
                      {savingAC ? t('loading') : t('save')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => { setEditingAC(false); setAcDraft(story.acceptance_criteria ?? ''); }}>
                      {t('cancel')}
                    </Button>
                  </div>
                </div>
              ) : story.acceptance_criteria ? (
                <div className="mt-2 cursor-pointer" onClick={() => setEditingAC(true)}>
                  <DescriptionViewer description={story.acceptance_criteria} />
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setEditingAC(true)}
                  className="mt-2 w-full rounded-md border border-dashed border-border py-3 text-sm text-muted-foreground transition hover:border-primary hover:text-primary"
                >
                  + {t('addAcceptanceCriteria')}
                </button>
              )}
            </div>

            {/* Attachments — chat-attach 자산 미러 (E-FILE S4) */}
            <div>
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">{t('attachments')}</span>
                <button
                  type="button"
                  onClick={() => attachInputRef.current?.click()}
                  disabled={uploadingAttachment || (story.attachments?.length ?? 0) >= STORY_ATTACHMENT_LIMIT}
                  className="flex items-center gap-1 text-xs text-muted-foreground transition hover:text-foreground disabled:opacity-40"
                >
                  <Paperclip className="size-3" /> + 추가
                </button>
              </div>
              <input
                ref={attachInputRef}
                type="file"
                multiple
                className="hidden"
                accept="image/*,.pdf,.txt,.md,.csv"
                onChange={(e) => { void handleAttachFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }}
              />
              {story.attachments && story.attachments.length > 0 ? (
                <div className="mt-2 flex flex-col gap-1.5">
                  {story.attachments.map((att, i) => {
                    const isImage = att.content_type?.startsWith('image/');
                    const Icon = getFileIcon(att.content_type);
                    const label = att.name ?? '첨부파일';
                    return (
                      <div key={att.url ?? i} className="group relative">
                        {/* a54ddc16 B1: 보드 첨부도 auth-gated 서명 라우트 경유(chat과 동일 컴포넌트·3상태). */}
                        {att.url ? (
                          isImage ? (
                            <AttachmentImage storedUrl={att.url} storyId={story.id} alt={label} />
                          ) : (
                            <AttachmentFile storedUrl={att.url} storyId={story.id} label={label} Icon={Icon} />
                          )
                        ) : null}
                        <button
                          type="button"
                          onClick={() => void handleRemoveAttachment(att.url)}
                          className="absolute right-1 top-1 hidden rounded bg-destructive/20 p-0.5 text-destructive transition group-hover:block hover:bg-destructive/30"
                          aria-label="첨부 삭제"
                        >
                          <X className="size-3" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : !uploadingAttachment ? (
                <button
                  type="button"
                  onClick={() => attachInputRef.current?.click()}
                  className="mt-2 w-full rounded-md border border-dashed border-border py-3 text-sm text-muted-foreground transition hover:border-primary hover:text-primary"
                >
                  + {t('addAttachment')}
                </button>
              ) : null}
              {uploadingAttachment && (
                <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" /> {t('loading')}
                </div>
              )}
              {attachError && (
                <p className="mt-1 text-xs text-destructive">첨부 업로드에 실패했습니다. 다시 시도해 주세요.</p>
              )}
            </div>

            {/* Labels */}
            <div>
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                  <Tag className="size-3" />
                  <span>Labels</span>
                </div>
                <button
                  type="button"
                  onClick={() => setShowLabelPicker((v) => !v)}
                  className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted transition-colors"
                >
                  {showLabelPicker ? '닫기' : '+ 추가'}
                </button>
              </div>

              {loadingLabels ? (
                <p className="text-xs text-muted-foreground">{t('loading')}</p>
              ) : (
                <>
                  {storyLabels.length > 0 ? (
                    <div className="mb-2 flex flex-wrap gap-1.5">
                      {storyLabels.map((label) => (
                        <span key={label.itemLabelId} className="group relative inline-flex">
                          <LabelChip label={label} />
                          <button
                            type="button"
                            onClick={() => void handleDetachLabel(label.itemLabelId)}
                            className="absolute -right-1 -top-1 hidden h-3.5 w-3.5 items-center justify-center rounded-full bg-muted-foreground/20 text-foreground hover:bg-destructive/80 hover:text-destructive-foreground group-hover:flex"
                            aria-label={`Remove ${label.name}`}
                          >
                            <X className="size-2" />
                          </button>
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="mb-2 text-xs text-muted-foreground/60">라벨 없음</p>
                  )}

                  {showLabelPicker && (
                    <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-2">
                      {/* Existing org labels */}
                      {orgLabels.filter((l) => !storyLabels.some((sl) => sl.id === l.id)).length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {orgLabels
                            .filter((l) => !storyLabels.some((sl) => sl.id === l.id))
                            .map((label) => (
                              <button
                                key={label.id}
                                type="button"
                                onClick={() => void handleAttachLabel(label.id)}
                                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2 py-0.5 text-xs text-foreground transition hover:bg-muted"
                              >
                                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: label.color ?? '#8A8F98' }} />
                                {label.name}
                              </button>
                            ))}
                        </div>
                      )}
                      {/* New label form */}
                      <div className="flex items-center gap-1.5">
                        <div className="flex gap-1">
                          {LABEL_PRESET_COLORS.map((hex) => (
                            <button
                              key={hex}
                              type="button"
                              onClick={() => setNewLabelColor(hex)}
                              className={`h-4 w-4 rounded-full border-2 transition ${newLabelColor === hex ? 'border-foreground' : 'border-transparent'}`}
                              style={{ backgroundColor: hex }}
                              aria-label={hex}
                            />
                          ))}
                        </div>
                        <input
                          type="text"
                          value={newLabelName}
                          onChange={(e) => setNewLabelName(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') void handleCreateLabel(); }}
                          placeholder="새 라벨 이름"
                          className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary/40"
                        />
                        <button
                          type="button"
                          onClick={() => void handleCreateLabel()}
                          disabled={!newLabelName.trim() || creatingLabel}
                          className="rounded bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50 hover:bg-primary/90 transition"
                        >
                          {creatingLabel ? '...' : '생성'}
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Dependencies — v2 (그래프 + 추가 + 경고) */}
            <div>
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                  <GitFork className="size-3" />
                  <span>Dependencies</span>
                </div>
                <button
                  type="button"
                  onClick={() => setShowAddDep((v) => !v)}
                  className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted transition-colors"
                >
                  <Plus className="size-3" />{t('dep.add')}
                </button>
              </div>

              {/* 미완선행 경고 strip */}
              {(() => {
                const incompletePreds = deps.filter((d) =>
                  (d.dep_type === 'blocks' && d.to_id === story.id) ||
                  (d.dep_type === 'depends_on' && d.from_id === story.id)
                ).filter((d) => {
                  const otherId = d.dep_type === 'blocks' ? d.from_id : d.to_id;
                  return storyMap[otherId]?.status !== 'done';
                });
                if (incompletePreds.length === 0) return null;
                return (
                  <div className="mb-2 flex items-center gap-1.5 rounded-md border border-warning-border bg-warning-tint px-2.5 py-1.5 text-xs text-warning">
                    <AlertTriangle className="size-3 shrink-0" />
                    <span>{t('dep.incompletePreds', { count: incompletePreds.length })}</span>
                  </div>
                );
              })()}

              {loadingDeps ? (
                <p className="text-xs text-muted-foreground">{t('loading')}</p>
              ) : (
                <div className="space-y-1.5">
                  {/* 컴팩트 그래프 */}
                  {deps.length > 0 && (
                    <div className="mb-2 rounded-lg border border-border bg-muted/10 p-2">
                      <DependencyGraph
                        storyId={story.id}
                        deps={deps}
                        storyMap={storyMap}
                        onNavigate={onNavigate}
                      />
                    </div>
                  )}

                  {/* Blocked by (blocks && to_id=story) */}
                  {deps.filter((d) => d.dep_type === 'blocks' && d.to_id === story.id).map((d) => {
                    const blocker = storyMap[d.from_id];
                    return (
                      <div key={d.id} className="group flex w-full items-center gap-2 rounded-md border border-warning-border bg-warning-tint px-2.5 py-1.5 text-xs text-warning">
                        <button type="button" onClick={() => onNavigate?.(d.from_id)} className="flex min-w-0 flex-1 items-center gap-2 text-left" disabled={!onNavigate}>
                          <AlertTriangle className="size-3 shrink-0" />
                          <span className="font-medium shrink-0">Blocked by</span>
                          <span className="min-w-0 truncate">{blocker?.title ?? `#${d.from_id.slice(0, 6)}`}</span>
                          {blocker?.status ? <span className="ml-auto shrink-0 font-mono text-[10px] opacity-60">{blocker.status}</span> : null}
                        </button>
                        <button type="button" onClick={() => void handleRemoveDep(d.id)} className="hidden shrink-0 rounded p-0.5 hover:bg-warning/20 group-hover:block" aria-label="Remove">
                          <X className="size-3" />
                        </button>
                      </div>
                    );
                  })}

                  {/* Blocking (blocks && from_id=story) */}
                  {deps.filter((d) => d.dep_type === 'blocks' && d.from_id === story.id).map((d) => {
                    const blocked = storyMap[d.to_id];
                    return (
                      <div key={d.id} className="group flex w-full items-center gap-2 rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground">
                        <button type="button" onClick={() => onNavigate?.(d.to_id)} className="flex min-w-0 flex-1 items-center gap-2 text-left" disabled={!onNavigate}>
                          <GitFork className="size-3 shrink-0" />
                          <span className="font-medium shrink-0">Blocking</span>
                          <span className="min-w-0 truncate">{blocked?.title ?? `#${d.to_id.slice(0, 6)}`}</span>
                          {blocked?.status ? <span className="ml-auto shrink-0 font-mono text-[10px] opacity-60">{blocked.status}</span> : null}
                        </button>
                        <button type="button" onClick={() => void handleRemoveDep(d.id)} className="hidden shrink-0 rounded p-0.5 hover:bg-muted group-hover:block" aria-label="Remove">
                          <X className="size-3" />
                        </button>
                      </div>
                    );
                  })}

                  {/* Depends on (depends_on && from_id=story) — B4 */}
                  {deps.filter((d) => d.dep_type === 'depends_on' && d.from_id === story.id).map((d) => {
                    const target = storyMap[d.to_id];
                    return (
                      <div key={d.id} className="group flex w-full items-center gap-2 rounded-md border border-border bg-muted/20 px-2.5 py-1.5 text-xs text-muted-foreground">
                        <button type="button" onClick={() => onNavigate?.(d.to_id)} className="flex min-w-0 flex-1 items-center gap-2 text-left" disabled={!onNavigate}>
                          <GitFork className="size-3 shrink-0 rotate-90" />
                          <span className="font-medium shrink-0">Depends on</span>
                          <span className="min-w-0 truncate">{target?.title ?? `#${d.to_id.slice(0, 6)}`}</span>
                          {target?.status ? <span className="ml-auto shrink-0 font-mono text-[10px] opacity-60">{target.status}</span> : null}
                        </button>
                        <button type="button" onClick={() => void handleRemoveDep(d.id)} className="hidden shrink-0 rounded p-0.5 hover:bg-muted group-hover:block" aria-label="Remove">
                          <X className="size-3" />
                        </button>
                      </div>
                    );
                  })}

                  {/* Depended by (depends_on && to_id=story) — B4 */}
                  {deps.filter((d) => d.dep_type === 'depends_on' && d.to_id === story.id).map((d) => {
                    const source = storyMap[d.from_id];
                    return (
                      <div key={d.id} className="group flex w-full items-center gap-2 rounded-md border border-border bg-muted/20 px-2.5 py-1.5 text-xs text-muted-foreground">
                        <button type="button" onClick={() => onNavigate?.(d.from_id)} className="flex min-w-0 flex-1 items-center gap-2 text-left" disabled={!onNavigate}>
                          <GitFork className="size-3 shrink-0 -rotate-90" />
                          <span className="font-medium shrink-0">Depended by</span>
                          <span className="min-w-0 truncate">{source?.title ?? `#${d.from_id.slice(0, 6)}`}</span>
                          {source?.status ? <span className="ml-auto shrink-0 font-mono text-[10px] opacity-60">{source.status}</span> : null}
                        </button>
                        <button type="button" onClick={() => void handleRemoveDep(d.id)} className="hidden shrink-0 rounded p-0.5 hover:bg-muted group-hover:block" aria-label="Remove">
                          <X className="size-3" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* + 의존성 추가 폼 */}
              {showAddDep && (
                <div className="mt-2 space-y-2 rounded-lg border border-border bg-muted/20 p-2">
                  <div className="flex gap-1">
                    {(['blocks', 'depends_on'] as const).map((type) => (
                      <button
                        key={type}
                        type="button"
                        onClick={() => setDepType(type)}
                        className={`rounded px-2 py-0.5 text-[10px] font-medium transition ${depType === type ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'}`}
                      >
                        {type === 'blocks' ? t('dep.typeBlocks') : t('dep.typeDepends')}
                      </button>
                    ))}
                  </div>
                  <input
                    type="text"
                    value={depQuery}
                    onChange={(e) => setDepQuery(e.target.value)}
                    placeholder={t('dep.searchPlaceholder')}
                    className="w-full rounded border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary/40"
                  />
                  {depQueryResults.length > 0 && (
                    <ul className="max-h-32 overflow-y-auto rounded border border-border bg-background">
                      {depQueryResults.map((s) => (
                        <li key={s.id}>
                          <button
                            type="button"
                            onClick={() => void handleAddDep(s.id)}
                            disabled={addingDep}
                            className="w-full px-2 py-1.5 text-left text-xs hover:bg-muted truncate disabled:opacity-50"
                          >
                            {s.title}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>

            {/* E-GHAPP Bot-L.2: PR↔story 명시연결 관리(2-tier·connect-prompt 자체 처리) */}
            <PrLinkSection storyId={story.id} />

            {/* Outcome result (read-only) + 연결 가설 chip/picker — 인라인 intent 입력은
                S8c서 연결 가설 affordance로 대체(스토리서 가설 생성 금지·AC①). 결과 카드는
                legacy outcome 백필(1519fc60) 전까지 보존. */}
            <div className="space-y-3">
              {story.outcome_status && story.outcome_status !== 'n_a' ? (
                <OutcomeResultCard
                  status={story.outcome_status}
                  hypothesis={story.success_hypothesis}
                  result={story.outcome_result as OutcomeResult | null}
                  pendingMetricLabel={story.metric_definition?.metric}
                />
              ) : null}
              {projectId ? (
                <StoryHypothesesSection
                  storyId={story.id}
                  epicId={story.epic_id}
                  projectId={projectId}
                />
              ) : null}
              {/* H1-S8 surface②: 머지 게이트 evidence(read-only·gate 있을 때만 노출) */}
              <StoryMergeGate storyId={story.id} />
              {/* E-CANVAS AC2 attachment point — BE(C1-S3) 미착지 동안 404→무표시(mock 0). */}
              <ArtifactSection storyId={story.id} memberMap={memberMap} />
            </div>

            {/* Tabs for Tasks, Comments, Activity */}
            <Tabs defaultValue="tasks" className="w-full">
              <TabsList className="w-full">
                <TabsTrigger value="tasks" className="flex-1">Tasks ({tasks.length})</TabsTrigger>
                <TabsTrigger value="comments" className="flex-1">Comments ({comments.length})</TabsTrigger>
                <TabsTrigger value="activity" className="flex-1">Activity</TabsTrigger>
              </TabsList>

              <TabsContent value="tasks" className="mt-4 space-y-2">
                {tasks.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t('noTasks')}</p>
                ) : (
                  <>
                    <ul className="space-y-2">
                      {tasks.map((task) => (
                        <li key={task.id} className="flex items-center gap-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
                          <span className={`h-2.5 w-2.5 rounded-full ${taskTone(task.status)}`} />
                          <span className={task.status === 'done' ? 'text-muted-foreground line-through' : 'text-foreground'}>{task.title}</span>
                        </li>
                      ))}
                    </ul>
                    {nextTasksCursor ? (
                      <div className="mt-3 text-center">
                        <Button variant="outline" size="sm" onClick={onLoadMoreTasks} disabled={loadingMoreTasks || !onLoadMoreTasks}>
                          {loadingMoreTasks ? t('loading') : t('loadMore')}
                        </Button>
                      </div>
                    ) : null}
                  </>
                )}
              </TabsContent>

              <TabsContent value="comments" className="mt-4 space-y-4">
                {/* Comment input */}
                <div className="space-y-2">
                  <textarea
                    placeholder="Add a comment..."
                    value={commentInput}
                    onChange={(e) => setCommentInput(e.target.value)}
                    className="flex field-sizing-content min-h-[80px] w-full resize-none rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        void handleSubmitComment();
                      }
                    }}
                  />
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      onClick={handleSubmitComment}
                      disabled={!commentInput.trim() || submittingComment}
                    >
                      {submittingComment ? t('loading') : 'Comment'}
                    </Button>
                  </div>
                </div>

                {/* Comments list */}
                {loadingComments ? (
                  <p className="text-sm text-muted-foreground">{t('loading')}</p>
                ) : comments.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No comments yet</p>
                ) : (
                  <>
                    <ul className="space-y-3">
                      {comments.map((comment) => (
                        <li key={comment.id} className="rounded-md border border-border bg-muted/30 p-3">
                          <p className="whitespace-pre-wrap text-sm text-foreground">{comment.content}</p>
                          <div className="mt-2 flex items-center gap-2 text-[10px] font-mono text-muted-foreground">
                            <span>{memberMap[comment.created_by]?.name ?? '—'}</span>
                            <span>·</span>
                            <span>{new Date(comment.created_at).toLocaleString()}</span>
                          </div>
                        </li>
                      ))}
                    </ul>
                    {nextCommentsCursor ? (
                      <div className="text-center">
                        <Button variant="outline" size="sm" onClick={handleLoadMoreComments} disabled={loadingMoreComments}>
                          {loadingMoreComments ? t('loading') : t('loadMore')}
                        </Button>
                      </div>
                    ) : null}
                  </>
                )}
              </TabsContent>

              <TabsContent value="activity" className="mt-4 space-y-2">
                {loadingActivities ? (
                  <p className="text-sm text-muted-foreground">{t('loading')}</p>
                ) : activities.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No activity yet</p>
                ) : (
                  <>
                    <ul className="space-y-2">
                      {activities.map((activity) => {
                        const actorName = memberMap[activity.created_by]?.name ?? '—';
                        const isLong = (activity.old_value?.length ?? 0) > 40 || (activity.new_value?.length ?? 0) > 40;
                        const expanded = expandedActivityId === activity.id;
                        return (
                          <li key={activity.id} className="rounded-md border border-border bg-muted/30 p-3">
                            <div className="text-sm">{formatActivityMessage(activity, expanded)}</div>
                            <div className="mt-1 flex items-center gap-2 text-[10px] font-mono text-muted-foreground">
                              <span>{actorName}</span>
                              <span>·</span>
                              <span>{new Date(activity.created_at).toLocaleString()}</span>
                              {isLong ? (
                                <button
                                  type="button"
                                  onClick={() => setExpandedActivityId(expanded ? null : activity.id)}
                                  className="ml-auto rounded px-1.5 py-0.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                                >
                                  {expanded ? '접기' : '펼치기'}
                                </button>
                              ) : null}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                    {nextActivitiesCursor ? (
                      <div className="text-center">
                        <Button variant="outline" size="sm" onClick={handleLoadMoreActivities} disabled={loadingMoreActivities}>
                          {loadingMoreActivities ? t('loading') : t('loadMore')}
                        </Button>
                      </div>
                    ) : null}
                  </>
                )}
              </TabsContent>
            </Tabs>
          </div>
        </div>
      </div>
    </div>

      {/* Delete confirm dialog */}
      <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>스토리를 삭제하시겠습니까?</DialogTitle>
            <DialogDescription>
              이 작업은 되돌릴 수 없습니다. 스토리에 연결된 태스크도 함께 삭제됩니다.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setShowDeleteConfirm(false)} disabled={deleting}>
              취소
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void handleDelete()}
              disabled={deleting}
            >
              {deleting ? '삭제 중…' : '영구 삭제'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}
