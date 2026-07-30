'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import { AlertTriangle, ArrowLeftRight, Check, GitFork, Loader2, Paperclip, Plus, Tag, Trash2, X } from 'lucide-react';
import type { KanbanStory, KanbanMember, DependencyEdge } from './types';
import { normalizeAssigneePatch } from './types';
import type { SendAttachment } from '@/hooks/use-chat-sse';
import { getFileIcon } from '@/lib/file-icon';
import { imageFilesFromClipboard } from '@/lib/clipboard-image';
import { parseCursorMeta } from '@/lib/pagination';
import { AttachmentImage } from '@/components/chat/attachment-image';
import { AttachmentFile } from '@/components/chat/attachment-file';
import { EntityChip, getEntityHref } from '@/components/chat/embed-card';
import { ReferenceDropNotice, parseDroppedReferences, type DroppedReference } from '@/components/chat/reference-drop-notice';
import { LabelChip, LABEL_PRESET_COLORS, type LabelData } from '@/components/ui/label-chip';
import { DependencyGraph } from './dependency-graph';
import { OutcomeResultCard, type OutcomeResult } from '@/components/outcome/outcome-result-card';
import { StoryHypothesesSection } from '@/components/hypotheses/story-hypotheses-section';
import { StoryMergeGate } from '@/components/cage/story-merge-gate';
import { EvidenceSection } from '@/components/verify/evidence-section';
import { ChatProofSection } from '@/components/verify/chat-proof-section';
import { deriveInFlightTrustChip } from '@/services/verify';
import type { ProofState } from '@/components/proof-capsule/proof-capsule';
import { Workcell, type WorkcellMessage } from '@/components/workcell/workcell';
import { initials } from '@/lib/storage/format';
import { ArtifactSection } from '@/components/canvas/artifact-section';
import { StuckHandoffSection } from '@/components/cage/stuck-handoff-section';
import { EntityBacklinksSection } from '@/components/shared/entity-backlinks-section';
import { EntityAwareTextarea } from '@/components/shared/entity-aware-textarea';
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
import { useFocusTrap } from '@/hooks/use-focus-trap';
import { HumanOnlyAction } from '@/components/ui/human-only-action';

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
  if (status === 'in-progress') return 'bg-info'; // story #2023 ⓑ: 진행중=시스템 상태(L5), 브랜드 아님
  return 'bg-background/20';
}

// BE _MAX_STORY_ATTACHMENTS 정합 (schemas/story.py)
const STORY_ATTACHMENT_LIMIT = 10;

// story #2269(C-11) AC0-2 보너스 발견: `entity:story:<uuid>` 새 형식 링크의 href가 두 겹
// 필터에 막혀 있었다(EntityChip 경로가 chat-bubble.tsx 전용이던 이유 — description/AC
// 뷰어엔 안 뚫려 있었다) —
//   ①react-markdown 자체의 `urlTransform`(기본값 `defaultUrlTransform`)이 http/https 등
//     "안전 프로토콜"이 아니면 href를 통째로 빈 문자열로 지운다(rehype 단계보다 먼저 작동).
//   ②그걸 통과해도 rehype-sanitize의 defaultSchema가 protocols.href에 http/https/irc/ircs/
//     mailto/xmpp만 허용해 다시 지운다.
// 그래서 chat-bubble.tsx는 이미 `urlTransform` 오버라이드를 갖고 있었다(그쪽엔 ②가 아예
// 없다 — 이 컴포넌트는 rehypeSanitize를 쓰는 게 다른 점) — 이 컴포넌트는 둘 다 뚫어야 한다.
// `descriptionSanitizeSchema`는 ②를 위한 것이고, 아래 `DescriptionViewer`의 `urlTransform` prop이
// ①을 위한 것 — 두 겹 다 `entity:` 하나만 추가로 열고 그 외(특히 javascript:/data:)는
// 원래 막던 대로 둔다(뮤테이션 자가검증: description-viewer.test.tsx의 "javascript:/data:
// href는 여전히 막힌다" 테스트가 그 증거).
// story #2269(C-11) AC0-2 축B(2026-07-29, PO 지적) — `bare-number:` 도 같은 두 겹 필터를
// 통과해야 한다(entity:와 동일 이유). `#<번호>`를 render-time에 `[#번호](bare-number:번호)`
// 로 치환(`prepareBareNumberRefs`)해 이 스킴으로 태우므로 여기서도 열어야 한다.
const descriptionSanitizeSchema = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), 'entity', 'bare-number'],
  },
};

// story #2269(C-11) AC0-3 세는 정의(backend `mention_parser._BARE_STORY_NUMBER_RE`/
// `_redact_code_spans`와 1:1 대응 — 정의가 두 곳에 따로 있으면 그 자체가 드리프트 위험이라
// 정규식을 문자 그대로 포트했다). word-boundary로 `##`·`foo#123` 오탐 배제, 코드블록/인라인
// 코드 안은 참조 아님으로 제외.
const BARE_STORY_NUMBER_RE = /(?<![\w#])#(\d+)\b/g;
const FENCED_CODE_BLOCK_RE = /```[\s\S]*?```/g;
const INLINE_CODE_SPAN_RE = /`[^`\n]*`/g;

function redactCodeSpans(content: string): string {
  const blank = (m: string) => ' '.repeat(m.length);
  return content.replace(FENCED_CODE_BLOCK_RE, blank).replace(INLINE_CODE_SPAN_RE, blank);
}

// story #2269(C-11) AC0-2 축B — chat-bubble.tsx의 `prepareMentions()`(@name → [@name]
// (mention:name))와 동형. `#2258` 을 `[#2258](bare-number:2258)` 마크다운 링크 문법으로
// 바꿔 기존 `a` 오버라이드 경로에 태운다. ⛔치환은 redact된 사본에서 위치만 찾고, 실제
// 삽입은 **원문**에 대해 한다(redact가 길이를 보존하므로 위치가 그대로 대응) — 코드블록
// 안의 원문 백틱 등을 훼손하지 않기 위함.
function prepareBareNumberRefs(content: string): string {
  const redacted = redactCodeSpans(content);
  let result = '';
  let lastIndex = 0;
  BARE_STORY_NUMBER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BARE_STORY_NUMBER_RE.exec(redacted)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    result += content.slice(lastIndex, start);
    result += `[#${m[1]}](bare-number:${m[1]})`;
    lastIndex = end;
  }
  result += content.slice(lastIndex);
  return result;
}

// story #2021 후속(PO 리뷰): components 객체를 렌더 함수 안에서 인라인으로 만들면 매 렌더
// 새 함수 참조가 되어 react-markdown이 서브트리를 리마운트한다(chat-bubble 근본원인과 동형).
// 이 패널은 댓글/액티비티 폴링·낙관 업데이트로 자주 리렌더되는 화면이라 위험이 실재한다.
// 다만 여기 오버라이드는 전부 stateless 순수 태그(a도 target=_blank 평문 링크, 자체 state
// 없음)라 useMemo조차 불필요 — 모듈 스코프 상수로 끌어올려 참조를 영구 고정한다.
const descriptionViewerComponents = {
  p: ({ children }: { children?: React.ReactNode }) => <p className="mb-2 break-words text-sm leading-6 text-muted-foreground last:mb-0">{children}</p>,
  h1: ({ children }: { children?: React.ReactNode }) => <h1 className="mb-2 text-lg font-bold text-foreground">{children}</h1>,
  h2: ({ children }: { children?: React.ReactNode }) => <h2 className="mb-2 text-base font-bold text-foreground">{children}</h2>,
  h3: ({ children }: { children?: React.ReactNode }) => <h3 className="mb-1.5 text-sm font-bold text-foreground">{children}</h3>,
  ul: ({ children }: { children?: React.ReactNode }) => <ul className="mb-2 ml-4 list-disc space-y-0.5 text-muted-foreground">{children}</ul>,
  ol: ({ children }: { children?: React.ReactNode }) => <ol className="mb-2 ml-4 list-decimal space-y-0.5 text-muted-foreground">{children}</ol>,
  li: ({ children }: { children?: React.ReactNode }) => <li className="text-sm leading-6">{children}</li>,
  // story #2165: 코드블럭은 전역 스크롤바 숨김 예외.
  pre: ({ children }: { children?: React.ReactNode }) => <pre className="mb-2 overflow-x-auto scrollbar-visible rounded-lg bg-muted p-3 text-[13px] text-foreground">{children}</pre>,
  code: ({ children }: { children?: React.ReactNode }) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-[13px] text-foreground">{children}</code>,
  blockquote: ({ children }: { children?: React.ReactNode }) => <blockquote className="mb-2 border-l-2 border-border pl-3 text-muted-foreground">{children}</blockquote>,
  // 긴급 정정(2026-07-28, PO 검수): description/AC 뷰어는 부모 div에 클릭=편집모드 진입
  // onClick이 걸려 있다(1093·1140줄) — 링크가 stopPropagation 없이 렌더돼 클릭이 그대로
  // 버블링, 링크가 새 탭으로 열리는 동시에 편집모드까지 열렸다. 링크 클릭은 여기서 끊는다.
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary underline underline-offset-2"
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </a>
  ),
  strong: ({ children }: { children?: React.ReactNode }) => <strong className="font-semibold text-foreground">{children}</strong>,
  em: ({ children }: { children?: React.ReactNode }) => <em className="italic text-muted-foreground">{children}</em>,
  hr: () => <hr className="my-2 border-border" />,
};

// story #2269(C-11) AC0 — chat-bubble.tsx의 isGhostReference와 동형(레지스트리 분리 이유는
// ChatMessage['references']와 shape은 같지만 출처가 다른 엔드포인트라 별개 타입으로 둔다).
export interface OutgoingReference {
  target_type: string;
  target_id: string;
}

function isGhostOutgoingReference(
  references: OutgoingReference[] | undefined,
  targetType: string,
  targetId: string,
): boolean {
  if (references === undefined) return false;
  const type = targetType.toLowerCase();
  const id = targetId.toLowerCase();
  return !references.some((r) => r.target_type.toLowerCase() === type && r.target_id.toLowerCase() === id);
}

// export: story #2328(C-11 ㉡층) — 후보/검색 전환 판정을 StoryDetailPanel 전체 마운트 없이
// 격리 검증하기 위함(같은 이유로 huge prop surface라 전체 마운트 테스트가 비실용적). 유나
// 규격 ①③: 2글자 미만(빈 입력·1글자·다 지운 것 — 한 상태)이면 후보, 아니면 검색 결과 —
// 섞지 않는다. 트림 후 판정(공백만 있는 입력도 "미만"으로 취급).
export function selectDepPickerItems<T>(
  depQuery: string,
  candidates: T[],
  searchResults: T[],
): { items: T[]; showingCandidates: boolean } {
  const showingCandidates = depQuery.trim().length < 2;
  return { items: showingCandidates ? candidates : searchResults, showingCandidates };
}

interface RawStoryRow {
  id: string;
  title: string;
  is_reference_candidate?: boolean;
  matched_snippet?: string | null;
}

// export: story #2328 — BE(PR#2659)는 필터링이 아니라 재정렬만 하므로(boost_candidates_from을
// 줘도 전체 목록이 돌아온다), is_reference_candidate===true인 것만 FE가 직접 골라낸다.
// 자기 자신 제외 + 상한 6(기존 검색 결과와 동일 cap, story-detail-panel.tsx:501)은 그대로.
export function extractReferenceCandidates(rows: RawStoryRow[], selfId: string): { id: string; title: string; matched_snippet?: string | null }[] {
  return rows
    .filter((s) => s.id !== selfId && s.is_reference_candidate === true)
    .slice(0, 6)
    .map((s) => ({ id: s.id, title: s.title, matched_snippet: s.matched_snippet }));
}

// export: 회귀 테스트(부모 클릭=편집모드 진입 wrapper 안에서 링크 클릭이 전파를 끊는지)를
// StoryDetailPanel 전체 마운트 없이 격리 검증하기 위함(story-detail-panel.tsx는 huge prop
// surface라 전체 마운트 테스트가 비실용적) — 동작 변경 없는 순수 export 추가.
//
// story #2269(C-11) AC0: `references`는 GET /api/stories/{id}/references?direction=outgoing
// 응답(이 story의 outgoing 참조 전체) — undefined면 유령 판정을 보류한다(#2622와 동일 폴백
// 원칙). `bareNumberTargets`는 같은 응답의 형제 필드(번호→story_id, AC0-2 축B) — undefined면
// `#<번호>` 치환 자체를 보류한다(축A 결과 없이 렌더하면 전부 거짓 유령이 된다). entity:/
// bare-number: 링크 렌더는 `a` 오버라이드 하나만 이 값들에 의존하므로 그 함수만 useMemo로
// 새로 만들고 나머지(descriptionViewerComponents)는 그대로 재사용해 리마운트 표면을 최소화.
export function DescriptionViewer({
  description, references, bareNumberTargets,
}: {
  description: string;
  references?: OutgoingReference[];
  bareNumberTargets?: Record<string, string>;
}) {
  const components = useMemo(() => ({
    ...descriptionViewerComponents,
    a: ({ href, children }: { href?: string; children?: React.ReactNode }) => {
      // story #2269(C-11) AC0-2 축B — `prepareBareNumberRefs`가 만든 `bare-number:<번호>`
      // 토큰. `bareNumberTargets`에 매칭되면 정상 칩(entityId=uuid), 없으면(미해소·미로드
      // 둘 다) **유령 칩**으로 그린다 — entityId 없이 ghost=true(EntityChip의 ghost 분기는
      // entityId를 아예 안 쓴다). ⛔"삭제됨"이 아니라 "대상이 없습니다"(EntityChip 기존
      // 문구, 시제 중립) 그대로 재사용 — PO 우려(「삭제됨」처럼 보이면 거짓)를 위해 새 문구를
      // 발명하지 않고 기존 문구가 이미 시제 중립임을 그대로 쓴다(문구 변경 0).
      const bareMatch = href?.match(/^bare-number:(\d+)$/);
      if (bareMatch) {
        const number = bareMatch[1]!;
        const targetId = bareNumberTargets?.[number];
        return (
          <span onClick={(e) => e.stopPropagation()}>
            <EntityChip
              entityType="story"
              entityId={targetId}
              label={`#${number}`}
              href={targetId ? getEntityHref('story', targetId) : null}
              ghost={!targetId}
            />
          </span>
        );
      }
      // id는 UUID만 허용 — chat-bubble.tsx의 entity: 파싱 규칙과 동일.
      const m = href?.match(/^entity:(\w+):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
      // ⛔asset은 reference_registry.ENTITY_RESOLVERS 밖의 FE 전용 타입(mention_parser.py
      // 주석 참조) — chat-bubble.tsx와 동일하게 일반 EntityChip 경로를 안 태운다.
      if (m && m[1]!.toLowerCase() !== 'asset') {
        const ghost = isGhostOutgoingReference(references, m[1]!, m[2]!);
        return (
          // 긴급 정정(2026-07-28) 재발 방지 — 부모 div의 편집모드 진입 onClick으로 버블링 금지.
          <span onClick={(e) => e.stopPropagation()}>
            <EntityChip entityType={m[1]!} entityId={m[2]!} label={String(children)} href={getEntityHref(m[1]!, m[2]!)} ghost={ghost} />
          </span>
        );
      }
      return descriptionViewerComponents.a({ href, children });
    },
  }), [references, bareNumberTargets]);

  // bareNumberTargets가 아직 없으면(미로드) 치환을 보류 — #<번호>는 그대로 평문(#2622와
  // 동일 폴백 원칙, 미판정을 유령으로 지어내지 않는다).
  const prepared = bareNumberTargets !== undefined ? prepareBareNumberRefs(description) : description;

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[[rehypeSanitize, descriptionSanitizeSchema]]}
      urlTransform={(url) => (url.startsWith('entity:') || url.startsWith('bare-number:') ? url : defaultUrlTransform(url))}
      components={components}
    >
      {prepared}
    </ReactMarkdown>
  );
}

export function StoryDetailPanel({ story, tasks, nextTasksCursor = null, loadingMoreTasks = false, onLoadMoreTasks, onClose, onStoryUpdate, onDeleteSuccess, memberMap = {}, members = [], storyMap = {}, epicMap = {}, sprintMap = {}, onNavigate, projectId }: StoryDetailPanelProps) {
  const t = useTranslations('board');
  // story #1959(P2-S3): 딥링크 매니페스트(story_detail→parentTab=all) — 콜드 진입 시 "전체"
  // 탭 루트를 BACK 대상으로 선주입. 카드 클릭으로 연 경우(history.length>1)는 no-op.
  useSyntheticParentTabHistory('/more');
  // story #2061 — 이 컴포넌트의 마운트 자체가 "열림"이라 active는 상수 true. Esc는 이미
  // 위(편집모드 우선 취소) 자체 핸들러가 있어 여기선 Tab 트랩+포커스 반환만 담당한다
  // (handleEscape:false — 이중 핸들러로 편집모드 취소 로직을 건너뛰지 않도록).
  const panelTrapRef = useFocusTrap(true, onClose, { handleEscape: false });
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
  // story #2315 — description/acceptance_criteria PATCH가 참조를 조용히 거를 수 있다(#2294와
  // 같은 병, story 저장 축). BE가 아직 사이드밴드를 안 실어도(parseDroppedReferences가 빈
  // 배열로 폴백) 안 깨지고, 실으면 바로 뜬다 — ephemeral(persist 안 함·패널 재오픈 시 소멸).
  const [referenceDropped, setReferenceDropped] = useState<DroppedReference[]>([]);
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
  // story #2328(C-11 ㉡층, 유나 규격 2026-07-29): 검색어 2글자 미만(빈 입력·1글자·다 지운
  // 것 — 한 상태)일 때 "아무것도 안 함" 대신 이 스토리 본문에 나온 의미 후보를 보인다.
  // 패널 열 때(showAddDep true 전이) «한 번»만 불러 상태로 들고 — 이후 쿼리를 지웠다 다시
  // 비워도 재요청하지 않는다(depCandidatesFetchedRef). 후보와 검색 결과는 절대 안 섞는다 —
  // 2글자 이상이면 이 배열이 아니라 depQueryResults를 그린다(아래 렌더 분기 참조).
  const [depCandidates, setDepCandidates] = useState<{ id: string; title: string; matched_snippet?: string | null }[]>([]);
  const depCandidatesFetchedRef = useRef(false);
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

  // description/AC 본문의 entity: 링크 유령 판정용 outgoing 참조 목록. ChatProofSection과
  // 같은 엔드포인트(GET /{id}/references?direction=outgoing)를 재사용한다(전용 라우트
  // 신설 0). 실패·미로드 시 undefined 유지 — #2622와 동일하게 판단 재료가 없으면 유령
  // 판정을 보류한다(false-ghost보다 미판정이 안전).
  const [outgoingRefs, setOutgoingRefs] = useState<OutgoingReference[] | undefined>(undefined);
  // story #2269(C-11) AC0-2 축B(2026-07-29, PO 지적) — 「#<번호>」 관찰 수집(축A, #2643)만
  // 해서는 화면에 아무것도 안 뜬다. 같은 응답의 형제 필드 `bare_number_targets`(번호→story_id)
  // 를 받아 DescriptionViewer의 render-time 치환에 넘긴다. undefined면 치환 자체를 보류(축A
  // 미로드와 동형 폴백 — 안 뜨는 게 거짓 렌더보다 안전).
  const [bareNumberTargets, setBareNumberTargets] = useState<Record<string, string> | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setOutgoingRefs(undefined);
    setBareNumberTargets(undefined);
    fetch(`/api/stories/${story.id}/references?direction=outgoing`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((json: { data?: unknown; bare_number_targets?: unknown } | null) => {
        if (cancelled || !json) return;
        const rows = Array.isArray(json.data) ? json.data : [];
        setOutgoingRefs(
          rows
            .filter((r): r is { target_type: string; target_id: string } =>
              typeof (r as { target_type?: unknown })?.target_type === 'string'
              && typeof (r as { target_id?: unknown })?.target_id === 'string')
            .map((r) => ({ target_type: r.target_type, target_id: r.target_id })),
        );
        if (json.bare_number_targets && typeof json.bare_number_targets === 'object') {
          setBareNumberTargets(json.bare_number_targets as Record<string, string>);
        }
      })
      .catch(() => { /* undefined 유지 — 유령/치환 판정 보류 */ });
    return () => { cancelled = true; };
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

  // story #2328(C-11 ㉡층): 기존 검색 게이트(위 useEffect의 `length < 2`)는 한 줄도 안
  // 건드린다 — 그 "else"가 "아무것도 안 함"에서 "후보를 보임"으로 바뀌는 것뿐이라, 후보는
  // 별도 소스(boost_candidates_from)로 따로 불러온다. BE는 필터링이 아니라 재정렬만 하므로
  // (PR#2659) is_reference_candidate===true인 것만 FE가 직접 골라낸다.
  //
  // 패널을 닫으면 ref를 풀어 "다음에 열 때 다시 부른다" — 닫힘이 자연스러운 무효화 신호라
  // (PO 지적, 2026-07-30). 호출 횟수는 여전히 "사람이 패널을 여는 횟수"만큼이라 늘지 않는다
  // (타이핑마다 부르는 게 아님 — 스펙 ①이 금지하는 것은 그것 하나뿐).
  // ⛔지금 안 하는 것 — 패널이 열린 채로 본문을 저장해 BE가 새 후보를 만들어도(write-path
  // 훅) 이 패널은 갱신하지 않는다. 다음 판으로 미룬다(오늘 규율 — 갭을 적어 남긴다).
  // ⚠️테스트 갭 — `depQuery` 길이에 따라 "무엇을 보이는가"는 순수 함수(selectDepPickerItems/
  // extractReferenceCandidates)로 빼 dep-picker-candidates.test.ts가 잡지만, 이 effect의
  // showAddDep 전이/ref 리셋 자체는 effect라 단위테스트가 못 잡는다 — 이 자리를 만지면
  // "닫고 다시 열어 후보가 새로 오는지"를 손으로(라이브) 확認할 것.
  useEffect(() => {
    if (!showAddDep) { depCandidatesFetchedRef.current = false; return; }
    if (depCandidatesFetchedRef.current) return;
    depCandidatesFetchedRef.current = true;
    const params = new URLSearchParams({ boost_candidates_from: story.id });
    if (projectId) params.set('project_id', projectId);
    fetch(`/api/stories?${params}`)
      .then((r) => r.ok ? r.json() : null)
      .then((json) => {
        const results = (json?.data ?? []) as RawStoryRow[];
        setDepCandidates(extractReferenceCandidates(results, story.id));
      })
      .catch(() => {});
  }, [showAddDep, story.id, projectId]);

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

  // story #2258 AC2 — 검증요청: BE(request-verification)는 이미 있었는데 화면이 부르지 않던 경로.
  // 서버 응답의 gate를 그대로 chipGates에 반영(낙관적 아님 — 실제로 저장된 것을 다시 읽는다).
  const [requestingVerification, setRequestingVerification] = useState(false);
  const handleRequestVerification = async () => {
    if (requestingVerification) return;
    setRequestingVerification(true);
    try {
      const res = await fetch(`/api/stories/${story.id}/request-verification`, { method: 'POST' });
      if (res.ok) {
        const gate = await res.json() as { gate_type: string; status: string; neutral_facts?: Record<string, unknown> | null };
        setChipGates((prev) => [...prev.filter((g) => g.gate_type !== 'qa'), gate]);
        addToast({ type: 'success', title: t('verificationRequested') });
      } else {
        addToast({ type: 'error', title: t('verificationRequestFailed') });
      }
    } catch {
      addToast({ type: 'error', title: t('verificationRequestFailed') });
    } finally {
      setRequestingVerification(false);
    }
  };

  // story #2258 AC3: 대기 해제 조건(dep_type) «수정» — 삭제 후 재생성이 아니라 같은 행을 PATCH.
  // 서버 응답의 dep_type을 그대로 반영(낙관적 플립 아님 — 실제로 저장된 값을 다시 읽는다).
  const [updatingDepId, setUpdatingDepId] = useState<string | null>(null);
  const handleToggleDepType = async (dep: DependencyEdge) => {
    if (updatingDepId) return;
    const nextType = dep.dep_type === 'blocks' ? 'depends_on' : 'blocks';
    setUpdatingDepId(dep.id);
    try {
      const res = await fetch(`/api/dependencies/${dep.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dep_type: nextType }),
      });
      if (res.ok) {
        const updated = await res.json() as DependencyEdge;
        setDeps((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));
      } else {
        addToast({ type: 'error', title: t('dep.addFailed') });
      }
    } catch {
      addToast({ type: 'error', title: t('dep.addFailed') });
    } finally {
      setUpdatingDepId(null);
    }
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

  // story #2315 — patchStory는 예전엔 `json.data`만 읽어 최상위 형제 필드를 전부 버렸다(채팅
  // handleSend가 raw 최상위에서 command_gate를 읽는 것과 같은 자리인데, 여기는 그렇게 안 하고
  // 있었다). description/acceptance_criteria PATCH는 BE가 참조를 추출하는데(#2599)
  // 그 결과(`references.dropped[]`)를 아직 안 실어보내는 상태 — 그래도 미리 읽는 쪽을 갖춰
  // 둔다: parseDroppedReferences는 필드가 없으면 빈 배열로 안전하게 폴백하므로(throw 0),
  // BE가 나중에 사이드밴드를 실어도 FE를 따로 안 건드려도 되고, 지금 당장도 안 깨진다.
  const patchStory = async (body: Record<string, unknown>): Promise<{ story: KanbanStory | null; dropped: DroppedReference[] }> => {
    const res = await fetch(`/api/stories/${story.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { story: null, dropped: [] };
    const json = await res.json();
    return { story: json.data as KanbanStory, dropped: parseDroppedReferences(json) };
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
    const { story: updated } = await patchStory({ title: titleDraft.trim() });
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
    const { story: updated } = await patchStory({ assignee_ids: next });
    if (updated) {
      // story #2133 — BE 응답(assignee_ids 우선, 없으면 로컬 next)을 normalizeAssigneePatch로
      // 통과시켜 assignee_id를 손으로 다시 계산하지 않는다.
      const assigneePatch = normalizeAssigneePatch({ assignee_ids: updated.assignee_ids ?? next });
      assigneeIdsRef.current = assigneePatch.assignee_ids;
      setLocalAssigneeIds(assigneePatch.assignee_ids);
      onStoryUpdate?.({ ...story, ...assigneePatch });
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
    const { story: updated } = await patchStory({ assignee_ids: [] });
    if (updated) {
      onStoryUpdate?.({ ...story, ...normalizeAssigneePatch({ assignee_ids: [] }) });
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
    const { story: updated, dropped } = await patchStory({ description: descriptionDraft || null });
    setSavingDescription(false);
    setEditingDescription(false);
    setReferenceDropped(dropped);
    if (updated) onStoryUpdate?.({ ...story, description: updated.description });
  };

  const handleSaveAC = async () => {
    if (acDraft === (story.acceptance_criteria ?? '')) {
      setEditingAC(false);
      return;
    }
    setSavingAC(true);
    const { story: updated, dropped } = await patchStory({ acceptance_criteria: acDraft || null });
    setSavingAC(false);
    setEditingAC(false);
    setReferenceDropped(dropped);
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
      const { story: updated } = await patchStory({ attachments: next });
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
    const { story: updated } = await patchStory({ attachments: next });
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
          // story #2230: BE meta 필드는 snake_case(next_cursor) — camelCase 로 읽어 항상
          // undefined였던 것이 커서가 죽어 보이던 세 번째 원인(BE 미반영·프록시 이중포장과 직렬).
          // story #2231 AC4: 그 casing 판단을 여기서 다시 하지 않는다 — 공용 파서로 위임.
          setNextCommentsCursor(parseCursorMeta(json.meta, 'story-detail-panel:comments').nextCursor);
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
          // story #2231 AC4: BE list_activities는 아직 cursor를 안 낸다(CAPPED-NO-NEXT-PAGE) —
          // 지금은 meta가 없어 "더 없음"으로 낙하하는 게 맞지만, 조용히가 아니라 console.error로
          // 드러나야 다음에 BE가 cursor를 추가했을 때 이 자리가 계속 죽어 있는 걸 놓치지 않는다.
          setNextActivitiesCursor(parseCursorMeta(json.meta, 'story-detail-panel:activities').nextCursor);
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
        setNextCommentsCursor(parseCursorMeta(json.meta, 'story-detail-panel:comments:loadMore').nextCursor);
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
        setNextActivitiesCursor(parseCursorMeta(json.meta, 'story-detail-panel:activities:loadMore').nextCursor);
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
        aria-hidden="true"
      />

      {/* Panel */}
      <div
        ref={panelTrapRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={story.title}
        className="fixed inset-0 z-50 bg-background shadow-xl outline-none backdrop-blur-xl lg:inset-y-0 lg:left-auto lg:right-0 lg:w-full lg:max-w-3xl lg:border-l lg:border-border"
      >
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
              {/* story #2258 AC2 — 검증요청: pending "qa" gate가 없을 때만 요청 버튼, 있으면 대기 배지. */}
              {chipGates.some((g) => g.gate_type === 'qa' && g.status === 'pending') ? (
                <span className="inline-flex items-center gap-1.5 rounded-[7px] bg-proof-amber-soft px-2 py-0.5 text-[11px] font-semibold text-proof-amber">
                  <span className="size-1.5 rounded-full bg-proof-amber" aria-hidden="true" />
                  {t('verificationPending')}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => void handleRequestVerification()}
                  disabled={requestingVerification}
                  className="inline-flex items-center gap-1 rounded-[7px] border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
                >
                  {requestingVerification ? t('loading') : t('requestVerification')}
                </button>
              )}
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
            {/* story #2265(C-7) PR1b — "대화 근거"(proof). EvidenceSection 바로 아래,
                "근거" 계열 이름으로(구조 이름 "참조"·"임베드" 미노출, PO 확定). 0건이면
                EvidenceSection과 동일하게 null 렌더. */}
            <ChatProofSection storyId={story.id} />
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {/* story #2104 — BE stories.py:1056이 human-only로 hard-delete를 403 거부한다(되돌릴
                수 없는 조작). 에이전트 계정에도 트리거를 열어두면 #2091/#2103과 같은 결함이라
                미리 숨긴다. */}
            <HumanOnlyAction>
              <button
                type="button"
                onClick={() => setShowDeleteConfirm(true)}
                className="flex items-center gap-1 rounded-md border border-destructive/40 px-2.5 py-1.5 text-xs text-destructive transition hover:bg-destructive/10"
                aria-label={t('deleteStory')}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </HumanOnlyAction>
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
                  // story #2133 — normalizeAssigneePatch가 assignee_id/assignee_ids 정합을
                  // 강제해, 이 경로만 한쪽을 빠뜨리는 실수(#2384 근본)가 구조적으로 불가능해진다.
                  onAssigneePatched={(aid) => {
                    const assigneePatch = normalizeAssigneePatch({ assignee_id: aid });
                    assigneeIdsRef.current = assigneePatch.assignee_ids;
                    setLocalAssigneeIds(assigneePatch.assignee_ids);
                    onStoryUpdate?.({ ...story, ...assigneePatch });
                  }}
                />
              </div>
            )}

            {/* E-DG S12: handoff stuck UX — DISPATCH 직후·handoff_stuck일 때만 조건부 렌더(자체 게이트) */}
            <StuckHandoffSection storyId={story.id} memberMap={memberMap} />

            {/* story #2299(E-CONNECT): 이것을 가리키는 것들 — doc/chat_message 참조 목록 첫 자리
                (doc [slug]/view는 후속 판). */}
            <EntityBacklinksSection entityType="story" entityId={story.id} />

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
                  {/* story #2264(C-6) AC3: 새 자리 비용 = 설정 한 줄 — <textarea>를
                      <EntityAwareTextarea>로 바꾸고 projectId만 넘기면 `#` 피커가 붙는다.
                      참조 코어(chat-input-entity-tokens.ts/use-entity-picker.ts) diff 0. */}
                  <EntityAwareTextarea
                    value={descriptionDraft}
                    onChange={setDescriptionDraft}
                    onPaste={handlePasteAttach}
                    projectId={projectId}
                    placeholder="Markdown 형식으로 작성하세요..."
                    className="flex field-sizing-content min-h-[160px] w-full resize-y rounded-lg border border-input bg-transparent px-2.5 py-2 font-mono text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
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
                // 긴급 정정(2026-07-28, PO 검수·#2275) — 본문 전체에 클릭=편집모드 onClick이
                // 걸려 있으면 안의 링크 등 대화형 요소가 stopPropagation을 각각 붙여야만
                // 살아남는 구조라 위험하다(#2566은 링크 하나만 증상 패치). 상호작용 규약을
                // 아예 「편집 진입은 위 ✎ 수정 버튼으로만」으로 좁혀 원천 차단한다 — 본문
                // 안의 무엇을 눌러도 편집모드가 끼어들 수 없다.
                // ⛔이 div에 onClick을 다시 붙이지 않는다 — 편집 진입은 «수정 버튼»으로만.
                // 본문 안의 링크·멘션·체크박스가 자기 일을 해야 하기 때문이다.
                <div className="mt-2">
                  <DescriptionViewer description={story.description} references={outgoingRefs} bareNumberTargets={bareNumberTargets} />
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
                  {/* story #2264(C-6) AC3: 같은 설정 한 줄 — description과 동일 컴포넌트 재사용. */}
                  <EntityAwareTextarea
                    value={acDraft}
                    onChange={setAcDraft}
                    projectId={projectId}
                    placeholder="Markdown 형식으로 작성하세요..."
                    className="flex field-sizing-content min-h-[160px] w-full resize-y rounded-lg border border-input bg-transparent px-2.5 py-2 font-mono text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
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
                // #2275 — description과 동일 처방: 편집 진입은 위 ✎ 수정 버튼으로만.
                // ⛔이 div에 onClick을 다시 붙이지 않는다 — 본문 안의 링크·멘션·체크박스가
                // 자기 일을 해야 하기 때문이다.
                <div className="mt-2">
                  <DescriptionViewer description={story.acceptance_criteria} references={outgoingRefs} bareNumberTargets={bareNumberTargets} />
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

            {/* story #2315 — description/acceptance_criteria 저장이 참조를 조용히 거를 수
                있다는 것을 화면이 말한다(#2294와 동일 컴포넌트·동일 규율 — 종류-무관 문구). */}
            {referenceDropped.length > 0 && (
              <ReferenceDropNotice dropped={referenceDropped} onDismiss={() => setReferenceDropped([])} />
            )}

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
              {/* story #2105 2차 — handleAttachFiles가 재시도 전 setAttachError(false)를 먼저
                  호출해(위 정의) 매 시도마다 언마운트→리마운트된다. */}
              {attachError && (
                <p role="alert" aria-live="assertive" aria-atomic="true" className="mt-1 text-xs text-destructive">첨부 업로드에 실패했습니다. 다시 시도해 주세요.</p>
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
                          className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
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
                        <button type="button" onClick={() => void handleToggleDepType(d)} disabled={updatingDepId === d.id} className="hidden shrink-0 rounded p-0.5 hover:bg-warning/20 group-hover:block" aria-label={t('dep.toggleType')} title={t('dep.toggleType')}>
                          <ArrowLeftRight className="size-3" />
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
                        <button type="button" onClick={() => void handleToggleDepType(d)} disabled={updatingDepId === d.id} className="hidden shrink-0 rounded p-0.5 hover:bg-muted group-hover:block" aria-label={t('dep.toggleType')} title={t('dep.toggleType')}>
                          <ArrowLeftRight className="size-3" />
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
                        <button type="button" onClick={() => void handleToggleDepType(d)} disabled={updatingDepId === d.id} className="hidden shrink-0 rounded p-0.5 hover:bg-muted group-hover:block" aria-label={t('dep.toggleType')} title={t('dep.toggleType')}>
                          <ArrowLeftRight className="size-3" />
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
                        <button type="button" onClick={() => void handleToggleDepType(d)} disabled={updatingDepId === d.id} className="hidden shrink-0 rounded p-0.5 hover:bg-muted group-hover:block" aria-label={t('dep.toggleType')} title={t('dep.toggleType')}>
                          <ArrowLeftRight className="size-3" />
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
                    className="w-full rounded border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                  {/* story #2328(C-11 ㉡층): 2글자 미만이면 후보(depCandidates), 2글자
                      이상이면 검색 결과(depQueryResults) — 절대 안 섞는다(갈아치움). */}
                  {(() => {
                    const { items, showingCandidates } = selectDepPickerItems(depQuery, depCandidates, depQueryResults);
                    if (items.length === 0) return null;
                    return (
                      <ul className="focus-inset max-h-32 overflow-y-auto rounded border border-border bg-background">
                        {showingCandidates && (
                          <li aria-hidden className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                            {t('dep.candidatesHeader')}
                          </li>
                        )}
                        {items.map((s) => (
                          <li key={s.id}>
                            <button
                              type="button"
                              onClick={() => void handleAddDep(s.id)}
                              disabled={addingDep}
                              className="w-full px-2 py-1.5 text-left text-xs hover:bg-muted disabled:opacity-50"
                            >
                              <span className="block truncate">{s.title}</span>
                              {showingCandidates ? (
                                <span className="block truncate text-[11px] text-muted-foreground">
                                  {t('dep.candidateMentionHint')}
                                  {'matched_snippet' in s && s.matched_snippet ? ` · ${s.matched_snippet}` : ''}
                                </span>
                              ) : null}
                            </button>
                          </li>
                        ))}
                      </ul>
                    );
                  })()}
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
                    className="flex field-sizing-content min-h-[80px] w-full resize-none rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
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
