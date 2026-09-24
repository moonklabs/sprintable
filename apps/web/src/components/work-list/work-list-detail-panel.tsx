'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { FileText, Layers, X } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { getEntityHref } from '@/components/chat/embed-card';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { fetchWithAuth } from '@/lib/db/client';
import { deriveContentPostStatus } from '@/components/content/post-status';
import { deriveChannelPostView } from '@/components/content/channel-post-status';
import { StatusChip } from '@/components/content/status-chip';
import { EvidenceSection } from '@/components/verify/evidence-section';
import { ArtifactSection } from '@/components/canvas/artifact-section';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { GateSignatureApproval } from '@/components/cage/gate-signature-approval';
import { isRecipePublishGate, reviewedDraftOf } from '@/components/cage/gate-risk';
import { translateEntityStatus } from '@/components/chat/entity-status-labels';
import { formatRelativeTime } from '@/lib/storage/format';
import { resolveDisplayTimezone } from '@/components/content/schedule-format';
import { pickEulReulJosa, pickEuroJosa, pickIGaJosa } from '@/lib/korean-particle';
import { STATE_TEXT } from './work-list-row';
import type { WorkListRow } from './derive-work-list';
import {
  deriveGateState, gateConversationId, primaryActionLabelKey, riskBadgeVariant, riskSentenceKey,
  type WorkListGate,
} from './work-list-detail-actions';
import { useFlatHref } from '@/hooks/use-flat-href';

interface StoryDetail {
  self_reported: boolean | null;
  human_verified: boolean | null;
  human_verified_by: string | null;
  human_verified_at: string | null;
}

interface HypothesisSummary {
  id: string;
  statement: string;
  status: string;
}

interface DocBacklinkItem {
  id: string;
  doc: { id: string; title: string } | null;
  still_exists: boolean;
}

// story #3976 — 「일」 체크리스트 탭. GET /api/tasks?story_id= 그대로(신규 BE 0).
interface TaskChecklistItem {
  id: string;
  title: string;
  status: string;
}

// story #3976 CHANGES(페드루 PO C1, 2026-09-17 00:38Z, dev 실측 — moonklabs 스토리
// 로그 100건: story_updated의 81%에 context.old_status/new_status·14%에
// context.fields) — 「이력」 탭. GET /api/v2/activity-logs?entity_type=story&entity_id=
// (FE 프록시 /api/activity-logs, activity-log-view.tsx::ActivityLogItem과 동형 부분집합
// +context).
interface ActivityLogItem {
  id: string;
  actor_name: string | null;
  action: string;
  created_at: string;
  context: { old_status?: string; new_status?: string; fields?: string[] } | null;
}
interface ActivityLogResponse {
  items: ActivityLogItem[];
}

// story #3988(E-UX-OVERHAUL·「일감」 흡수 2/N) — 「발행물」 탭. 기존
// GET .../channel-posts/drafts·.../site-posts/drafts에 story #3988이 추가한
// work_item_id 필터로 그 일에 이어진 초안만 받는다(새 BE 계약 0 — 이미 있는
// 필드만 additive). 상태는 post-status.ts::deriveContentPostStatus(site)·
// channel-post-status.ts::deriveChannelPostView(channel)를 그대로 재사용(새
// 판정식 0) — 성과(조회·유입)는 이 탭에 안 그림(「결과」 몫, AC3).
interface ChannelPostDraftSummary {
  draft_id: string;
  channel: string;
  text_preview: string;
  gate_status: 'pending' | 'approved' | 'rejected' | null;
  reapproval_required: boolean | null;
  sealed_content_sha256: string | null;
  body_sha256: string;
  published_at: string | null;
  publication_status: 'container_created' | 'published' | 'failed' | 'unpublished' | null;
  error_code: string | null;
}
interface SitePostDraftSummary {
  draft_id: string;
  title: string;
  slug: string;
  gate_status: 'pending' | 'approved' | 'rejected' | null;
  reapproval_required: boolean | null;
  sealed_content_sha256: string | null;
  body_sha256: string;
  published_at: string | null;
}
type PublicationsTabState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; channel: ChannelPostDraftSummary[]; site: SitePostDraftSummary[] };

// story #3988 — 「발행물」 탭은 성과(조회·유입)는 안 그린다(AC3, 「결과」 몫) — 상태 칩과
// 열기 링크뿐이라 5상태 파생의 .status 값 하나면 충분하다(post-status.ts/channel-post-
// status.ts 재사용, 새 판정식 0).
function siteDraftStatus(d: SitePostDraftSummary) {
  return deriveContentPostStatus({
    gateStatus: d.gate_status ?? undefined,
    reapprovalRequired: d.reapproval_required ?? undefined,
    sealedBodySha256: d.sealed_content_sha256 ?? undefined,
    currentBodySha256: d.body_sha256,
    hasPublishedSitePost: d.published_at != null,
  }).status;
}
function channelDraftStatus(d: ChannelPostDraftSummary) {
  return deriveChannelPostView({
    gateStatus: d.gate_status ?? undefined,
    reapprovalRequired: d.reapproval_required ?? undefined,
    sealedBodySha256: d.sealed_content_sha256 ?? undefined,
    currentBodySha256: d.body_sha256,
    publicationStatus: d.publication_status,
    errorCode: d.error_code,
    publishedAt: d.published_at,
  }).status;
}

// 낱말 표 §⑤-1 3875(2026-09-17 00:32Z 등재) — «유형» 라벨. 미등록 필드는 «알 수
// 없음»이 아니라 중립 라벨 1개("그 밖의 변경")로 접는다(딱 하나, 원시 필드명 노출 0).
const HISTORY_FIELD_LABEL_KEY: Record<string, string> = {
  title: 'historyFieldTitle',
  assignee_id: 'historyFieldAssignee',
  epic_id: 'historyFieldEpic',
  sprint_id: 'historyFieldSprint',
};

// 픽셀 커밋 CHANGES 5(페드루 PO 판정 09:45Z, CI run 34828958082 RED) — story #2691/#2689
// 회귀가드(verify-no-new-raw-fetch-api.ts)가 콜드마운트 GET의 raw fetch(`/api/...`)를
// 막는다(401 재시도 없이 삼키는 결함 클래스). fetchWithAuth(@/lib/db/client)로 교체 —
// 그 가드가 명시하는 정본 처방 그대로, 재구현 0.
async function fetchJsonData<T>(url: string): Promise<T | null> {
  try {
    const res = await fetchWithAuth(url);
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: T };
    return json.data ?? null;
  } catch {
    return null;
  }
}

// story #3988 — 「발행물」 탭 전용(fetchJsonData와 달리 실패를 삼키지 않는다, AC2가
// 요구하는 보이는 「다시 시도」를 내려면 ok/error를 구분해야 한다). org_id는 이
// 패널이 (authenticated) 안이라 useDashboardContext에서 그대로(신규 콜 0).
async function fetchDraftsForWorkItem(
  orgId: string, workItemId: string,
): Promise<{ ok: true; channel: ChannelPostDraftSummary[]; site: SitePostDraftSummary[] } | { ok: false }> {
  try {
    const [channelRes, siteRes] = await Promise.all([
      fetchWithAuth(`/api/organizations/${orgId}/channel-posts/drafts?work_item_id=${workItemId}`),
      fetchWithAuth(`/api/organizations/${orgId}/site-posts/drafts?work_item_id=${workItemId}`),
    ]);
    if (!channelRes.ok || !siteRes.ok) return { ok: false };
    const channelJson = (await channelRes.json()) as { data?: ChannelPostDraftSummary[] };
    const siteJson = (await siteRes.json()) as { data?: SitePostDraftSummary[] };
    return { ok: true, channel: channelJson.data ?? [], site: siteJson.data ?? [] };
  } catch {
    return { ok: false };
  }
}

/** story #3845 — findPendingInbox(derive-work-list.ts)와 동일 fallback(task 레벨 먼저,
 * 없으면 그 부모 story 레벨) — 다만 이 함수는 실 GateResponse 전체 필드(risk_grade·
 * gate_type·id)가 필요해 inbox 요약이 아니라 `/api/gates`를 직접 부른다. */
async function fetchPendingGate(row: WorkListRow, storyId: string): Promise<WorkListGate | null> {
  const tryFetch = async (workItemId: string, workItemType: string) => {
    const items = await fetchJsonData<WorkListGate[]>(
      `/api/gates?work_item_id=${workItemId}&work_item_type=${workItemType}&status=pending`,
    );
    return items && items.length > 0 ? items[0]! : null;
  };
  const direct = await tryFetch(row.workItemId, row.workItemType);
  if (direct) return direct;
  if (row.workItemType === 'task') return tryFetch(storyId, 'story');
  return null;
}

// story #3976 CHANGES(페드루 PO C1) — 「이력」 문장의 «무엇을»을 실 context에서 뽑는다
// (생성=그대로 · 상태 전후 있으면 SSOT 라벨로 「상태를 {old} → {new}로」 · fields 있으면
// §3875 유형 라벨(모르면 중립 폴백 1개) · 그 외(진짜 아무 근거 없음)도 같은 중립 폴백).
// t: 'workList' 네임스페이스 useTranslations 인스턴스, locale: 목적어 조사 계산용(§⑤
// korean-particle.ts 관례 — en 템플릿은 조사가 없어 label 그대로 씀).
function historyClaim(item: ActivityLogItem, t: ReturnType<typeof useTranslations>, locale: string): string {
  if (item.action.endsWith('_created')) return t('historyActionCreated');

  const oldStatus = item.context?.old_status;
  const newStatus = item.context?.new_status;
  if (oldStatus && newStatus) {
    const oldLabel = translateEntityStatus('story', oldStatus) ?? oldStatus;
    const newLabel = translateEntityStatus('story', newStatus) ?? newStatus;
    // §⑤ 규율(story #3900) — 값 의존 조사("으로/로")는 템플릿에 못 박지 않는다(배치म
    // 의존적, verify-scoped-i18n-honorific-tone.test.ts가 이걸 잡는다) — 조사까지 미리
    // 합쳐 하나의 값으로 넘긴다(historyFieldChanged의 을/를과 동형 처리).
    const newDisplay = locale === 'ko' ? `${newLabel}${pickEuroJosa(newLabel)}` : newLabel;
    return t('historyStatusChanged', { old: oldLabel, new: newDisplay });
  }

  const fields = item.context?.fields ?? [];
  const knownFieldKey = fields.map((f) => HISTORY_FIELD_LABEL_KEY[f]).find((k): k is string => !!k);
  const fieldLabel = knownFieldKey ? t(knownFieldKey) : null;
  if (fieldLabel) {
    const display = locale === 'ko' ? `${fieldLabel}${pickEulReulJosa(fieldLabel)}` : fieldLabel;
    return t('historyFieldChanged', { field: display });
  }

  // 알려진 status 전후도 fields 매치도 없음(진짜 근거 부재·미등록 필드뿐) — 중립 폴백
  // 1개(§3875 "그 밖의 변경", 딱 하나 — 「활동했어요」류 발명 0).
  return t('historyOtherChange');
}

export interface WorkListDetailPanelProps {
  row: WorkListRow;
  storyId: string;
  storyTitle: string;
  goalTitle: string;
  onClose: () => void;
  className?: string;
  /** 픽셀 커밋 ①(페드루 PO 판정 2026-09-14 09:11Z) — 지금 필터 화면에는 이 행이 안 보이는지.
   * true면 안내 배너+필터 지우기 버튼을 띄운다("URL이 SSOT" — 필터로 가려져도 ?row= 딥링크는
   * 유효해야 한다). 미전달(undefined)이면 배너를 안 그린다(work-list-shell.tsx가 항상 넘기지만,
   * 다른 호출부가 생겨도 안전한 기본값). */
  isHiddenByFilter?: boolean;
  /** ①의 「필터 지우기」 버튼 핸들러 — isHiddenByFilter가 true일 때만 실제로 쓰인다. */
  onClearFilters?: () => void;
}

export function WorkListDetailPanel({
  row, storyId, storyTitle, goalTitle, onClose, className, isHiddenByFilter = false, onClearFilters,
}: WorkListDetailPanelProps) {
  const t = useTranslations('workList');
  const flatHref = useFlatHref(); // story #4226 — flat 링크 `?p=`
  const tCommon = useTranslations('common');
  const tCage = useTranslations('cage');
  const locale = useLocale();
  const { tz } = resolveDisplayTimezone();
  const { currentMemberType, orgId } = useDashboardContext();

  const [story, setStory] = useState<StoryDetail | null>(null);
  // 픽셀 커밋 CHANGES 2(페드루 PO 판정 09:40Z) — 3탭 다 "로딩 중"과 "진짜 0건"을 구분해야
  // 각자 빈 상태 문구를 정확한 시점에만 보여준다(로딩 중에 미리 "없어요"라고 말하면 거짓).
  // null=로딩 중·빈 배열=로딩 끝났는데 0건(이 구분이 목적이라 length===0 하나로 뭉개지
  // 않는다).
  const [hypotheses, setHypotheses] = useState<HypothesisSummary[] | null>(null);
  const [docs, setDocs] = useState<DocBacklinkItem[] | null>(null);
  // 픽셀 커밋 CHANGES 2(페드루 PO 판정 09:40Z) — ArtifactSection 자체의 빈 상태는 「그리기/
  // 가져오기」 CTA가 있는 무거운 카드(전체 캔버스용 설계)라 이 360px 우패널엔 안 맞는다.
  // artifactCount만 가볍게 별도 조회해 0이면 이 패널 자기만의 1줄 muted 문구로 대체하고,
  // 1건 이상일 때만 ArtifactSection을 그대로 쓴다(그 컴포넌트 자체는 안 건드림).
  const [artifactCount, setArtifactCount] = useState<number | null>(null); // null=로딩 중
  const [tasks, setTasks] = useState<TaskChecklistItem[] | null>(null); // story #3976 — null=로딩 중
  const [activityLogs, setActivityLogs] = useState<ActivityLogItem[] | null>(null); // story #3976 — null=로딩 중
  const [gate, setGate] = useState<WorkListGate | null | undefined>(undefined); // undefined=로딩 중
  const [transitioning, setTransitioning] = useState(false);
  // story #4190 — 'draft_changed' = 409 gate_draft_changed(서명 흐름에서 본 초안이 그 사이 새 버전이 됨 — 게이트 상세와 같은
  // 문장 · loadGate()로 재조회해 카드가 최신 버전을 그린다).
  const [transitionError, setTransitionError] = useState<'forbidden' | 'draft_changed' | 'other' | null>(null);
  const [approved, setApproved] = useState(false);
  // story #3988 — 「발행물」 탭은 다른 5탭과 달리 패널이 열릴 때 같이 안 부른다(첫 화면
  // 콜 수 무증가, AC2 "탭 열 때만 조회"). idle=아직 그 탭을 연 적 없음.
  const [activeTab, setActiveTab] = useState('evidence');
  const [publications, setPublications] = useState<PublicationsTabState>({ kind: 'idle' });
  // story #3988 — 아래 행-전환 effect가 [row, storyId]에만 반응해야 한다(activeTab을
  // deps에 넣으면 탭을 바꿀 때마다 이 effect 전체가 재실행돼 다른 5탭의 "패널 열릴 때
  // 1회 조회"가 깨진다) — 그래도 그 effect 안에서 "지금" activeTab을 읽어야 하니 ref로.
  const activeTabRef = useRef(activeTab);
  useEffect(() => { activeTabRef.current = activeTab; }, [activeTab]);
  const orgIdRef = useRef(orgId);
  useEffect(() => { orgIdRef.current = orgId; }, [orgId]);
  // story #3988 CHANGES-1(페드루 PO 판정 2026-09-17 03:49Z) — A행에서 「발행물」 탭을 연
  // 채(조회 진행 中) B행으로 옮기면 A의 늦은 응답이 B 화면에 얹히는 경합. 세 조회 자리
  // (행전환 effect·탭 onValueChange·재시도) 전부 이 ref에 "지금 요청 대상 storyId"를
  // 적어 두고, 응답 도착 시 그 사이 다른 요청(다른 storyId)이 새로 시작됐으면(ref가
  // 이미 바뀌어 있으면) 버린다.
  const publicationsRequestForRef = useRef<string | null>(null);
  const runPublicationsFetch = useCallback((org: string, forStoryId: string) => {
    publicationsRequestForRef.current = forStoryId;
    setPublications({ kind: 'loading' });
    void fetchDraftsForWorkItem(org, forStoryId).then((res) => {
      if (publicationsRequestForRef.current !== forStoryId) return;
      setPublications(res.ok ? { kind: 'ready', channel: res.channel, site: res.site } : { kind: 'error' });
    });
  }, []);

  const loadGate = useCallback(async () => {
    setGate(await fetchPendingGate(row, storyId));
  }, [row, storyId]);

  useEffect(() => {
    let cancelled = false;
    setStory(null);
    setHypotheses(null);
    setDocs(null);
    setArtifactCount(null);
    setTasks(null);
    setActivityLogs(null);
    setGate(undefined);
    setTransitionError(null);
    setApproved(false);
    // story #3988 — 다른 행으로 옮기면 「발행물」 탭도 다시 idle(새 storyId 기준으로
    // 다시 조회해야 한다 — 옛 행 결과를 새 행에 그대로 보여주면 안 된다). activeTab
    // 자체는 안 되돌린다(다른 탭 보다가 행을 바꿔도 같은 탭에 머무는 게 자연스럽다) —
    // 단, 지금 이미 발행물 탭이 열려 있는 채로 행을 바꾸면 onValueChange가 다시 안
    // 불려서(값이 안 바뀌므로) idle에 머문 채 스켈레톤이 안 풀리는 결함이 생긴다 —
    // 그 경우엔 여기서 곧장 새 storyId로 조회한다.
    setPublications({ kind: 'idle' });
    // CHANGES-1 — 탭이 지금 안 열려 있어도(아래 if가 새 요청을 안 쏴도) ref는 항상 이
    // storyId로 갱신한다: 그래야 옛 storyId로 나가 있던 요청(예: 방금 A에서 쐈던 요청)의
    // 응답이 늦게 와도 "지금은 이미 다른 storyId"임을 보고 버릴 수 있다.
    publicationsRequestForRef.current = storyId;
    if (activeTabRef.current === 'publications') {
      if (orgIdRef.current) {
        runPublicationsFetch(orgIdRef.current, storyId);
      } else {
        // 작은 것(페드루 PO 판정) — orgId가 없으면 로딩을 못 시작하니 스켈레톤에
        // 영원히 갇힌다. 오류 상태로 명시해 「다시 시도」가 뜨게 한다.
        setPublications({ kind: 'error' });
      }
    }

    void fetchJsonData<StoryDetail>(`/api/stories/${storyId}`).then((v) => { if (!cancelled) setStory(v); });
    void fetchJsonData<HypothesisSummary[]>(`/api/hypotheses?story_id=${storyId}`).then((v) => { if (!cancelled) setHypotheses(v ?? []); });
    void fetchJsonData<DocBacklinkItem[]>(`/api/stories/${storyId}/backlinks?source_type=doc`).then((v) => { if (!cancelled) setDocs(v ?? []); });
    void fetchJsonData<unknown[]>(`/api/visual-artifacts?story_id=${storyId}`).then((v) => { if (!cancelled) setArtifactCount((v ?? []).length); });
    // story #3976 — 「일」 체크리스트(기존 /api/tasks 재사용, 상세 패널을 열 때만 — 첫
    // 화면 콜 수 무증가).
    void fetchJsonData<TaskChecklistItem[]>(`/api/tasks?story_id=${storyId}`).then((v) => { if (!cancelled) setTasks(v ?? []); });
    // story #3976 — 「이력」(기존 activity-logs 재사용, 3971 정정 대상과 같은 API).
    void fetchJsonData<ActivityLogResponse>(`/api/activity-logs?entity_type=story&entity_id=${storyId}`)
      .then((v) => { if (!cancelled) setActivityLogs(v?.items ?? []); });
    fetchPendingGate(row, storyId).then((v) => { if (!cancelled) setGate(v); }).catch(() => { if (!cancelled) setGate(null); });

    return () => { cancelled = true; };
  }, [row, storyId, runPublicationsFetch]);

  // 카디르 계약값 ⑥(페드루 판정 2026-09-14 10:55Z) — 「같은 화면 두 소스」결함 처방. row.state는
  // 목록 로드 시점의 inbox 스냅샷이고 주 액션 버튼은 이 패널이 연 시점의 fresh gate(gate state,
  // fetchPendingGate)에서 파생된다 — 목록 로드 뒤 게이트가 새로 생기면 상태 줄은 비고 버튼만
  // 그려지는 모순이 생겼다(정합 테스트 0이었음). 불변식: 패널 안 상태 문장과 주 액션은 항상
  // 같은 fetch 결과(gate)에서 파생돼야 한다.
  // ① gate===undefined(로딩 中) — 상태 줄도 주 액션 버튼(canShowPrimaryAction, 아래)도 그리지
  //   않는다(둘 다 !!gate 게이팅이라 자연히 같이 비게 된다).
  // ② gate가 있으면(fresh, 방금 이 패널이 열며 받은 값) 그 gate에서 재계산 — deriveGateState
  //   (derive-work-list.ts의 stateFromInboxItem과 같은 함수, SSOT 통일).
  // ③ fresh 결과가 없으면(gate===null) 게이트 유래 스냅샷 낱말(awaiting_approval/
  //   awaiting_signature)은 그리지 않는다 — row.state가 그 둘이 아닌 경우(awaiting_answer·
  //   in_progress·done)만 그대로 쓴다(게이트 밖 상태는 이 모순 축과 무관하므로 안전).
  const gateDerivedState =
    gate === undefined ? undefined
    : gate ? deriveGateState(gate)
    : row.state === 'awaiting_approval' || row.state === 'awaiting_signature' ? undefined
    : (row.state ?? undefined);
  const stateText = gateDerivedState ? STATE_TEXT[gateDerivedState] : undefined;
  const riskKey = gate ? riskSentenceKey(gate) : null;
  const riskBadge = gate ? riskBadgeVariant(gate) : null;
  const labelKey = gate ? primaryActionLabelKey(gate) : null;
  const conversationId = gate ? gateConversationId(gate) : null;
  // 픽셀 커밋 ②(페드루 PO 판정 2026-09-14 09:11Z) — gates/[id]/page.tsx의 isSigFlowGate와
  // 정확히 같은 판정. primaryActionLabelKey가 라벨을, 이 값이 «어느 UI를 그릴지»를 정한다 —
  // 같은 SSOT에서 파생되므로 라벨과 실제 렌더가 항상 짝을 이룬다(따로 계산하면 드리프트
  // 위험). 카디르 계약값 ⑥(10:55Z) — deriveGateState로 통일(이 파일 안에서만도 세 번째
  // 독립 계산이었다: primaryActionLabelKey·상태 줄 위 gateDerivedState·이 줄).
  const isSigFlowGate = !!gate && deriveGateState(gate) === 'awaiting_signature';

  // story #3845 — 에이전트 뷰어는 버튼 자체를 안 보인다(403-회피, approvals-queue.tsx의
  // `currentMemberType === 'human'` 게이팅과 동일 SSOT — DashboardContext #2103).
  const canShowPrimaryAction = currentMemberType === 'human' && !!gate && !approved;

  const submitTransition = useCallback(async (status: 'approved' | 'rejected', evidenceViewed: boolean, note?: string) => {
    if (!gate) return;
    const reviewedDraft = reviewedDraftOf(gate);
    setTransitioning(true);
    setTransitionError(null);
    try {
      const res = await fetchWithAuth(`/api/gates/${gate.id}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // 픽셀 커밋 ②(페드루 PO 판정 2026-09-14 09:11Z, 정정) — evidence_viewed를 여기서
        // 하드코딩하지 않는다. 저위험(평문 버튼) 경로는 evidenceViewed=false로 호출되고,
        // 고위험(GateSignatureApproval) 경로는 그 컴포넌트의 onApprove가 호출될 때만
        // true로 호출된다 — 그 콜백 자체가 canSign=evidenceViewed&&reason(내부 체크박스+
        // 사유 textarea)로 게이팅돼 있어(gate-signature-approval.tsx), true를 여기서
        // 다시 검증할 필요 없이 "그 콜백이 불렸다"는 사실 자체가 "사람이 실제로 체크박스를
        // 봤다"는 증거다(gates/[id]/page.tsx의 동일 계약 그대로 재사용 — 새 근거열람
        // 추적을 이 패널이 독자로 만들지 않는다).
        // story #4190 — 레시피 발행 게이트면 서명 흐름의 초안 카드가 그린 (draft_id, version)도(없으면 키 없음).
        body: JSON.stringify({
          status, evidence_viewed: evidenceViewed, note: note ?? null,
          ...(reviewedDraft ? { reviewed_draft_id: reviewedDraft.id, reviewed_draft_version: reviewedDraft.version } : {}),
        }),
      });
      if (res.status === 403) { setTransitionError('forbidden'); return; }
      if (!res.ok) {
        const errBody = await res.json().catch(() => null) as { error?: { code?: string } } | null;
        if (errBody?.error?.code === 'gate_draft_changed') {
          setTransitionError('draft_changed');
          await loadGate();
          return;
        }
        setTransitionError('other');
        return;
      }
      if (status === 'approved') setApproved(true);
      await loadGate();
    } catch {
      setTransitionError('other');
    } finally {
      setTransitioning(false);
    }
  }, [gate, loadGate]);

  // 저위험(평문) 경로 — evidence_viewed 없이(=false) 호출.
  const handlePlainApprove = useCallback(() => { void submitTransition('approved', false); }, [submitTransition]);
  // 고위험(서명) 경로 — GateSignatureApproval의 onApprove만 이 경로를 부른다.
  const handleSignedApprove = useCallback((reason: string) => { void submitTransition('approved', true, reason); }, [submitTransition]);
  // GateSignatureApproval은 onReject를 필수로 요구한다(그 컴포넌트의 「변경 요청」 버튼이
  // 항상 그려지므로) — 이 패널이 반려 흐름을 새로 설계하지 않되, 눌러도 아무 일도 안
  // 일어나는 죽은 버튼을 남기지 않도록 gates/[id]/page.tsx와 동일한 실 transition으로
  // 잇는다(evidence_viewed는 반려엔 의미 없어 false 고정).
  const handleReject = useCallback((reason: string) => { void submitTransition('rejected', false, reason); }, [submitTransition]);

  const retryPublications = useCallback(() => {
    if (!orgId) {
      setPublications({ kind: 'error' });
      return;
    }
    runPublicationsFetch(orgId, storyId);
  }, [orgId, storyId, runPublicationsFetch]);

  // story #3988 — 이 지역변수로 먼저 좁혀 두면(if/else) 아래 JSX의 중첩 삼항이
  // PublicationsTabState 판별 유니언을 안정적으로 좁힌다(JSX 삼항 체인 안에서
  // 직접 판별하면 마지막 갈래에서 좁혀지지 않는 TS 케이스 회피).
  let publicationsContent: React.ReactNode;
  if (publications.kind === 'idle' || publications.kind === 'loading') {
    publicationsContent = (
      <div className="space-y-2" data-testid="panel-publications-loading">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  } else if (publications.kind === 'error') {
    publicationsContent = (
      <div className="space-y-2" data-testid="panel-publications-error">
        <p className="text-xs text-destructive">{t('panelPublicationsError')}</p>
        <Button variant="outline" size="sm" onClick={retryPublications}>{tCommon('retry')}</Button>
      </div>
    );
  } else if (publications.channel.length === 0 && publications.site.length === 0) {
    publicationsContent = (
      <p className="text-xs text-muted-foreground" data-testid="panel-publications-empty">{t('panelEmptyPublications')}</p>
    );
  } else {
    const { channel, site } = publications;
    publicationsContent = (
      <ul className="space-y-1.5" data-testid="panel-publications-list">
        {site.map((d) => (
          <li key={`site-${d.draft_id}`} className="flex items-center justify-between gap-2 text-xs">
            <Link href={flatHref(`/content/${d.draft_id}`)} className="truncate text-primary underline-offset-2 hover:underline">
              {d.title}
            </Link>
            <StatusChip status={siteDraftStatus(d)} />
          </li>
        ))}
        {channel.map((d) => (
          <li key={`channel-${d.draft_id}`} className="flex items-center justify-between gap-2 text-xs">
            <Link href={flatHref(`/content/channel-posts/${d.draft_id}`)} className="truncate text-primary underline-offset-2 hover:underline">
              {d.text_preview}
            </Link>
            <StatusChip status={channelDraftStatus(d)} />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)} data-testid="work-list-detail-panel">
      <div className="flex items-start justify-between gap-2 border-b border-border p-4">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-foreground">{row.title}</h2>
          <p className="mt-1 truncate text-xs text-muted-foreground" data-testid="panel-belongs-to">
            {t('panelBelongsTo', { goal: goalTitle, story: storyTitle })}
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" aria-label={t('panelClose')} onClick={onClose}>
          <X className="size-4" aria-hidden="true" />
        </Button>
      </div>

      {/* 픽셀 커밋 ①(페드루 PO 판정 2026-09-14 09:11Z) — "URL이 SSOT": 필터로 안 보이는
          행이라도 ?row= 딥링크는 유효해야 한다("목록에 안 보이면 패널도 없다"는 같은
          화면 두 문장이 다른 세계가 되는 것 — URL은 선택했는데 화면은 무를 못 쓴다).
          data(필터 前 트리)에서 이 행을 찾아 패널은 항상 뜨고, filtered(화면에 보이는
          목록)에 없을 때만 이 배너로 그 사실을 알린다. */}
      {isHiddenByFilter ? (
        <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/50 px-4 py-2" data-testid="panel-hidden-by-filter-notice">
          <p className="text-xs text-muted-foreground">{t('panelHiddenByFilter')}</p>
          <Button type="button" variant="outline" size="sm" className="h-7 shrink-0" onClick={onClearFilters} data-testid="panel-clear-filters">
            {t('panelClearFilters')}
          </Button>
        </div>
      ) : null}

      <div className="overflow-y-auto focus-inset flex-1 space-y-3 p-4">
        <div className="space-y-1 text-xs">
          <p className="text-muted-foreground" data-testid="panel-assignee">
            {t('panelAssignee')}: <span className="text-foreground">{row.ownerName ?? t('panelAssigneeNone')}</span>
          </p>
          {stateText ? (
            <p className="text-muted-foreground" data-testid="panel-state">
              {t('panelState')}: <span className={cn('font-medium', stateText.className)}>{t(stateText.key)}</span>
            </p>
          ) : null}
        </div>

        {/* CHANGES 6(페드루 PO 판정 2026-09-14 10:09Z, CI「no-card-surfaceless-box」가드
            RED) — story #3785 규율: border+rounded만 있고 자기 배경(surface)이 없는
            div는 금지, Card(surface 기본 solid=border-border/80 bg-card)로. 시안 구조·
            레이아웃(flex·gap·padding)은 무변 — Card가 border/bg/radius를 제공하고
            나머지 유틸은 className으로 그대로. */}
        {gate && riskBadge ? (
          <Card className="flex items-center gap-2 p-2" data-testid="panel-risk">
            <Badge variant={riskBadge}>{t(gate.risk_grade === 'high' ? 'riskBadgeHigh' : 'chipLowRisk')}</Badge>
            {/* 픽셀 커밋 CHANGES 3(b, 페드루 PO 판정 09:40Z) — 저위험은 문장 0(pill과
                같은 사실 반복 금지). 고위험만 riskKey가 채워진다. */}
            {riskKey ? <p className="text-xs text-muted-foreground">{t(riskKey)}</p> : null}
          </Card>
        ) : null}

        {canShowPrimaryAction ? (
          <div className="space-y-2" data-testid="panel-primary-action-section">
            {/* 픽셀 커밋 ②(페드루 PO 판정 2026-09-14 09:11Z) — isSigFlowGate 분기는
                gates/[id]/page.tsx와 동형: 고위험은 GateSignatureApproval을 그대로
                재사용(근거열람 체크박스+사유 textarea를 이 패널이 재구현하지 않는다),
                저위험만 평문 버튼. */}
            {isSigFlowGate ? (
              <div data-testid="panel-signature-flow">
                <GateSignatureApproval
                  // story #4190 — 409 뒤 재조회로 초안 버전이 바뀌면 열람 체크·사유를 리셋(새 버전을 다시 보고 서명).
                  key={`${gate!.github_check_run_sha ?? ''}:${reviewedDraftOf(gate!)?.version ?? ''}`}
                  gate={gate!}
                  resolving={transitioning}
                  error={transitionError
                    ? (transitionError === 'forbidden' ? t('transitionForbidden')
                      : transitionError === 'draft_changed' ? tCage('gateDraftChangedError')
                      : t('transitionError'))
                    : null}
                  onApprove={handleSignedApprove}
                  onReject={handleReject}
                  compact
                />
              </div>
            ) : (
              <>
                {/* story #4190(유나 «본 버전 대조» 1) — 이 평문 자리는 초안 카드를 안 그린다. 레시피 발행 게이트면 승인 대신
                    카드가 있는 게이트 상세로 보내는 링크(같은 자리·같은 크기). 여기선 승인이 안 일어나 409 문장도 없다. */}
                {isRecipePublishGate(gate!) ? (
                  <Button asChild variant="default" size="sm">
                    <Link href={flatHref(`/gates/${gate!.id}`)} data-testid="panel-primary-action">{tCage('gateReviewDraftToApprove')}</Link>
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="default"
                    size="sm"
                    disabled={transitioning}
                    onClick={handlePlainApprove}
                    data-testid="panel-primary-action"
                  >
                    {t(labelKey!)}
                  </Button>
                )}
                {transitionError === 'forbidden' ? (
                  <p className="text-xs text-destructive" data-testid="panel-transition-error">{t('transitionForbidden')}</p>
                ) : null}
                {transitionError === 'other' ? (
                  <p className="text-xs text-destructive" data-testid="panel-transition-error">{t('transitionError')}</p>
                ) : null}
              </>
            )}
            {conversationId ? (
              <Button asChild variant="outline" size="sm">
                <Link href={flatHref(`/chats/${conversationId}`)} data-testid="panel-reply-action">{t('actionReply')}</Link>
              </Button>
            ) : null}
          </div>
        ) : null}
        {approved ? (
          <p className="text-xs text-success" data-testid="panel-approved-notice">{t('actionApproved')}</p>
        ) : null}

        {/* 픽셀 커밋 CHANGES 1(페드루 PO 판정 09:40Z) — 「분절 상자」(shadcn 기본 pill 배경)
            대신 밑줄 탭: variant="line"이 배경/pill을 이미 지운다(tabs.tsx 기존 메커니즘
            재사용 — 새 CSS 0). 활성 인디케이터 색만 시트론(citron, 이 컴포넌트의 기존
            기본값)에서 이 화면의 주 색(primary)으로 덮어쓴다 — after:bg-* 유틸은 같은
            충돌군이라 각 TabsTrigger의 className(cn() 마지막 인자)이 그대로 이긴다. 활성
            text-foreground·비활성 text-muted-foreground는 이미 기존 컴포넌트 기본값
            그대로(별도 지정 불요). */}
        <Tabs
          value={activeTab}
          onValueChange={(v) => {
            setActiveTab(v);
            // story #3988 AC2 — 「발행물」 탭을 처음 열 때만 조회(다른 5탭처럼 패널이
            // 열릴 때 같이 부르면 첫 화면 콜 수가 늘어난다). idle일 때만 fetch해서
            // 같은 탭을 여러 번 여닫아도 재조회 0(다른 행으로 옮기면 위 useEffect가
            // idle로 되돌려 다음 열 때 다시 조회).
            if (v === 'publications' && publications.kind === 'idle') {
              if (orgId) {
                runPublicationsFetch(orgId, storyId);
              } else {
                setPublications({ kind: 'error' });
              }
            }
          }}
          className="w-full"
        >
          <TabsList variant="line" className="w-full border-b border-border">
            <TabsTrigger value="evidence" className="flex-1 after:bg-primary" data-testid="panel-tab-evidence">{t('tabEvidence')}</TabsTrigger>
            <TabsTrigger value="tasks" className="flex-1 after:bg-primary" data-testid="panel-tab-tasks">{t('tabTasks')}</TabsTrigger>
            <TabsTrigger value="docs" className="flex-1 after:bg-primary" data-testid="panel-tab-docs">{t('tabDocs')}</TabsTrigger>
            <TabsTrigger value="artifacts" className="flex-1 after:bg-primary" data-testid="panel-tab-artifacts">{t('tabArtifacts')}</TabsTrigger>
            <TabsTrigger value="history" className="flex-1 after:bg-primary" data-testid="panel-tab-history">{t('tabHistory')}</TabsTrigger>
            <TabsTrigger value="publications" className="flex-1 after:bg-primary" data-testid="panel-tab-publications">{t('tabPublications')}</TabsTrigger>
          </TabsList>

          <TabsContent value="evidence" className="mt-4 space-y-3">
            {hypotheses === null ? (
              <p className="text-xs text-muted-foreground" data-testid="panel-hypotheses-loading">{tCommon('loading')}</p>
            ) : hypotheses.length === 0 ? (
              <p className="text-xs text-muted-foreground" data-testid="panel-hypotheses-empty">{t('panelEmptyHypotheses')}</p>
            ) : (
              <ul className="space-y-1.5" data-testid="panel-hypotheses-list">
                {hypotheses.map((h) => (
                  <li key={h.id} className="flex items-start gap-2 text-xs">
                    <Layers className="mt-0.5 size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="text-foreground">{h.statement}</span>
                  </li>
                ))}
              </ul>
            )}
            <EvidenceSection
              workItemId={storyId}
              workItemType="story"
              selfReported={story?.self_reported}
              humanVerified={story?.human_verified}
              humanVerifiedBy={story?.human_verified_by}
              humanVerifiedAt={story?.human_verified_at}
            />
          </TabsContent>

          <TabsContent value="docs" className="mt-4">
            {docs === null ? (
              <p className="text-xs text-muted-foreground" data-testid="panel-docs-loading">{tCommon('loading')}</p>
            ) : docs.length === 0 ? (
              <p className="text-xs text-muted-foreground" data-testid="panel-docs-empty">{t('panelEmptyDocs')}</p>
            ) : (
              <ul className="space-y-1.5" data-testid="panel-docs-list">
                {docs.filter((d) => d.doc !== null).map((d) => {
                  const href = getEntityHref('doc', d.doc!.id);
                  return (
                    <li key={d.id} className="flex items-center gap-2 text-xs">
                      <FileText className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                      {href ? (
                        <a href={href} className="truncate text-primary underline-offset-2 hover:underline">{d.doc!.title}</a>
                      ) : (
                        <span className="truncate text-foreground">{d.doc!.title}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </TabsContent>

          <TabsContent value="artifacts" className="mt-4">
            {artifactCount === null ? (
              <p className="text-xs text-muted-foreground" data-testid="panel-artifacts-loading">{tCommon('loading')}</p>
            ) : artifactCount === 0 ? (
              <p className="text-xs text-muted-foreground" data-testid="panel-artifacts-empty">{t('panelEmptyArtifacts')}</p>
            ) : (
              <ArtifactSection storyId={storyId} />
            )}
          </TabsContent>

          {/* story #3976 AC2 — 「일」 체크리스트(기존 GET /api/tasks?story_id= 재사용,
              task status 라벨은 entity-status-labels.ts SSOT — 새 어휘 0). */}
          <TabsContent value="tasks" className="mt-4">
            {tasks === null ? (
              <p className="text-xs text-muted-foreground" data-testid="panel-tasks-loading">{tCommon('loading')}</p>
            ) : tasks.length === 0 ? (
              <p className="text-xs text-muted-foreground" data-testid="panel-tasks-empty">{t('panelEmptyTasks')}</p>
            ) : (
              <ul className="space-y-1.5" data-testid="panel-tasks-list">
                {tasks.map((task) => {
                  const label = translateEntityStatus('task', task.status);
                  return (
                    <li key={task.id} className="flex items-center justify-between gap-2 text-xs">
                      <span className="truncate text-foreground">{task.title}</span>
                      {label ? <span className="shrink-0 text-muted-foreground">{label}</span> : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </TabsContent>

          {/* story #3976 AC1 — 「이력」(기존 GET /api/v2/activity-logs?entity_type=story&
              entity_id= 재사용, 새 BE 0 — 3971 정정 확認한 그 API). 문장 틀 = 「{누가}가
              {유형}」(action 원시값은 절대 노출 0 — 모르는 action은 제네릭 문구로 fail-closed). */}
          <TabsContent value="history" className="mt-4">
            {activityLogs === null ? (
              <p className="text-xs text-muted-foreground" data-testid="panel-history-loading">{tCommon('loading')}</p>
            ) : activityLogs.length === 0 ? (
              <p className="text-xs text-muted-foreground" data-testid="panel-history-empty">{t('panelEmptyHistory')}</p>
            ) : (
              <ul className="space-y-2" data-testid="panel-history-list">
                {activityLogs.map((log) => {
                  const actorName = log.actor_name ?? t('historyUnknownActor');
                  return (
                    <li key={log.id} className="text-xs">
                      <span className="text-foreground">
                        {actorName}{pickIGaJosa(actorName)} {historyClaim(log, t, locale)}
                      </span>
                      <span className="ml-1.5 text-muted-foreground">{formatRelativeTime(log.created_at, locale, tz)}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </TabsContent>

          {/* story #3988(E-UX-OVERHAUL·「일감」 흡수 2/N) — 「발행물」. 초안 상태+열기
              링크뿐(성과는 「결과」 몫, AC3). idle은 아직 안 열어봄(이 자리는 안 그려짐 —
              onValueChange가 열릴 때만 loading으로 바꾼다), error는 siblings와 달리
              보이는 「다시 시도」를 낸다(AC2 — fetchJsonData의 실패-삼킴과 구별). */}
          <TabsContent value="publications" className="mt-4">
            {publicationsContent}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
