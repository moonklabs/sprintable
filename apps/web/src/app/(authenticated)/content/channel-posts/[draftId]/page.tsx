'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { fetchWithAuth } from '@/lib/db/client';
import { channelLabel } from '@/lib/channel-label';
import { channelTextLength } from '@/components/content/channel-text-length';
import { parseSitePostApiError, type SitePostApiErrorInfo } from '@/components/content/api-error';
import { deriveChannelPostView, type ChannelPublicationStatus } from '@/components/content/channel-post-status';
import { describeExternalImpact } from '@/components/content/external-impact';
import { contentPostStatusLabelKey } from '@/components/content/post-status';
import { ScheduleAtDialog } from '@/components/content/schedule-at-dialog';
import { parseScheduledAtServerError } from '@/components/content/validate-scheduled-at';
import { deriveFailureAction, type CommandStatus } from '@/components/content/failure-action';
import { FailureActionBadge } from '@/components/content/failure-action-badge';
import { InsightSnapshotBlock, type InsightSnapshot } from '@/components/content/insight-snapshot-block';
import { CommentsSection, deriveCommentsFace, type CommentItem, type CommentsFace, type RawCommentsResponse } from '@/components/content/comments-section';
import { CommentConvertToTaskDialog } from '@/components/content/comment-convert-to-task-dialog';
import { formatScheduledAt, resolveDisplayTimezone } from '@/components/content/schedule-format';
import { GenerationBudgetIndicator, majorToMinor, type GenerationBudgetCurrency, type GenerationBudgetState } from '@/components/content/generation-budget-indicator';
import { GenerationBudgetExceededBanner } from '@/components/content/generation-budget-exceeded-banner';
import { isSandboxChannelDraft, SandboxTestBadge } from '@/components/content/sandbox-test-badge';
import { RawDetailsToggle } from '@/components/content/raw-details-toggle';
// story #3483 — 3472 2부에서 이 페이지에 있던 위반 표시 로직을 공용으로 뺐다
// (site-posts 상세와 재사용, 동작 무변).
import {
  ContentRuleViolationList, ContentRuleSubmitBlockedReason, type ContentRuleViolation,
} from '@/components/content/content-rule-violation';
import { formatFileSize } from '@/components/docs/extensions/file-node';

/**
 * story #3402(Phase1·마케팅운영, AC5/AC6·doc §3-1) — 채널 포스트 편집·상신(와이어프레임
 * T3·T4). site-posts 편집(content/[draftId]/page.tsx)과 계약 자체가 다르다 — 채널 포스트
 * 모델엔 title·summary·tags·body_md가 없고 `text`·`link_url`뿐이다(backend/app/routers/
 * channel_posts.py 실측). 이 조각은 편집+상신까지만 — 게이트/발행 상태 표시(승인 카드)는
 * story #3402 ④에서, 발행 자체(T7/T9)는 PR2에서 배선한다.
 *
 * AC6 — 글자 수는 channelTextLength(코드포인트, 서버 len()과 동일 단위)로 세고, 어댑터
 * 선언 한도(channel-connections의 max_text_length)를 넘으면 상신 자체를 막는다. 한도
 * 미선언(null)이면 "한도 미확認"으로 두되 상신은 막지 않는다(모르는 것을 근거로 사람을
 * 막지 않는다, doc §3-1).
 */

interface ChannelPostDraftDetail {
  draft_id: string;
  work_item_id: string;
  channel: string;
  connection_id: string;
  current_version: number;
  // story #3402 ④ — 단건 GET(story #3403)이 목록 항목(ChannelPostDraftListItem, #3394)과
  // 같은 shape를 준다 — 승인 카드가 필요로 하는 게이트 신호도 이미 여기 실려 있다.
  gate_status?: string | null;
  reapproval_required?: boolean | null;
  sealed_content_sha256?: string | null;
  body_sha256?: string;
  // story #3402 PR2(T7/T9) — 발행 상태. publication_status/error_code는 "최신 버전"
  // 기준, published_at/permalink/external_id는 "가장 최근 published" 기준(두 조인 축이
  // 다른 이유는 #3394 AC2 서비스 docstring 참고 — 편집→재승인 사이에도 과거 발행 이력이
  // 살아있어야 한다).
  publication_status?: ChannelPublicationStatus | null;
  permalink?: string | null;
  external_id?: string | null;
  error_code?: string | null;
  published_at?: string | null;
  published_body_sha256?: string | null;
  // story #3426(BE #3419/#3415, PR#3773) — 예약·재시도 상태. command_status는 최신
  // publication_command의 상태(pending/blocked/dead_letter면 「예약 취소」 버튼 대상 —
  // §17-10 정본). scheduled_at은 gate.sealed_scheduled_at(승인된 예약 시각, command의
  // scheduled_at 스냅샷과 다르다 — 재승인 뒤 갱신된다).
  command_status?: string | null;
  command_reason_code?: string | null;
  // story f061c1a3(BE 0e960006) — 재시도 BFF가 붙일 대상 command. 목록/단건 응답
  // (ChannelPostDraftListItem)이 이미 낸다 — command 자체가 없으면 null.
  command_id?: string | null;
  // story #3499(PO 確定 2026-09-05) — 최신 ChannelPublication.id(BE #3844 조각4 의존,
  // 이 PR 작성 시점 미착지 — additive, 없으면 undefined). command_id(PublicationCommand
  // 축)와 다른 테이블이라 혼동 금지.
  publication_id?: string | null;
  scheduled_at?: string | null;
  // story #3428(BE 620beefc·PR#3776, §17-14/§17-15) — 최신 버전에 이미지가 붙어 있으면
  // 그 「나가는 파생본」 공개 URL(카드 썸네일)과 원본/최종 width·bytes(배지 문구 조립
  // 재료). 없으면 전부 null. processing_kind='awaiting_container'는 command_status=
  // pending ∧ publication_status=container_created를 서버가 이미 파생한 값 — 화면이
  // 두 필드를 다시 조합판정하지 않는다.
  thumbnail_url?: string | null;
  image_original_width?: number | null;
  image_original_bytes?: number | null;
  image_final_width?: number | null;
  image_final_bytes?: number | null;
  image_was_converted?: boolean | null;
  // story #3422 B3(페드루 PO, 2026-09-04 13:14Z) — 실패 배지(FailureActionBadge)가 이
  // 화면에 mount 안 된 채로 남아 있던 갭. 단건 GET(ChannelPostDraftListItem과 동형
  // shape, backend/app/routers/channel_posts.py)이 이미 내는 필드.
  failure_kind?: string | null;
  next_retry_at?: string | null;
  processing_kind?: string | null;
  // story 15e481ce(#3453 AC2, 3437 위) — 이 채널 변형이 파생된 원문(site-posts draft
  // id). 없으면 null(소스 없는 단독 채널 초안, 정상값 — 유나 §14-3 "null이 정상값").
  source_content_item_id?: string | null;
  // story #3457 후속(BE #3817 착지분) — 원문 제목(배치조회, 이 필드 하나로 별도 왕복
  // 제거). source_content_item_id가 null이면 이것도 항상 null.
  source_title?: string | null;
  // 이 변형이 파생된 시점의 원문 latest version.id(버전 축, 초안 생성 시 고정).
  source_site_post_version_id?: string | null;
  // 원문의 지금 latest version.id(배치조회, 매 응답마다 최신값).
  source_current_site_post_version_id?: string | null;
  // story #3453 AC3 후속(페드루 PO 確定 2026-09-05) — 위 두 값의 비교 판정을 서버가
  // 한 곳에서 낸다(FE가 직접 비교하지 않는다 — id 비교식은 서버 전용, 이 필드만 본다).
  // true=원문이 파생 이후 개정됨 · false=안 바뀜 · null=모른다(레거시 파생분).
  source_changed?: boolean | null;
  // story #3514(BE 신설, PO 確定 2026-09-05) — lint-on-read. 단건 GET(이미 이 화면이
  // 로드 시 부르는 자리)에 규칙 위반 목록을 얹는다 — 저장/상신 응답과 같은 shape,
  // 계약 없으면(BE 미착지) undefined → 화면은 아무것도 지어내지 않는다.
  violations?: ContentRuleViolation[];
}

interface ChannelPostVersion {
  version_id: string;
  version: number;
  draft_id: string;
  text: string;
  link_url: string | null;
  body_sha256: string;
  author_kind: 'agent' | 'human';
  created_at: string;
  tagged_link_preview: string | null;
}

interface ChannelConnectionInfo {
  id: string;
  max_text_length: number | null;
  // story #3402 ④(AC9) — 나가는 계정을 승인 카드에 적는다. 없으면 account_id로 폴백
  // (지어내지 않는다, doc §3-4).
  account_label: string | null;
  account_id: string;
  // story #3426(BE #3419) — 「회수」 판정값. FE는 이 값 하나로 버튼을 그리거나 안 그린다
  // (scopes 원본을 다시 판정하지 않는다 — BE 단일 판정 지점, 그라운딩 확認). true면
  // unpublish_blocked_reason은 항상 null.
  can_unpublish: boolean;
  unpublish_blocked_reason: 'unsupported' | 'scope_insufficient' | null;
  // story #3458(유나 4회차 2차 발견) — can_unpublish는 어댑터 «성질»(unsupported·
  // scope_insufficient)만 판정하고 연결 «상태»(토큰 만료 등)는 안 본다. 정본 3653a18c
  // §3 "자격·범위·토큰 상태 셋 다 서야 초록" 중 토큰 조각이 이 필드다.
  status: 'active' | 'expired' | 'revoked' | 'error';
  // story #3428(BE 620beefc·PR#3776) — 이 연결(채널)의 이미지 규격 선언(어댑터 성질,
  // 하드코딩 금지 축 그대로 — T3-M 규격 태그 재료). image_max_count<=0이면 이 채널은
  // 이미지 미지원(§17-16 — 첨부 칸 자체를 그리지 않는다).
  image_formats: string[];
  image_max_bytes: number;
  image_aspect_max: number;
  image_width_min: number;
  image_width_max: number;
  image_color_space: string;
  image_max_count: number;
}

// story #3402 ④(AC7) — 한도 잔량은 조회값이고 조회 실패도 상태다. success=false는
// "0"이 아니라 "못 쟀다"를 뜻한다(§3-2 "모른다를 다르다로 접지 않는다") — 발행 버튼을
// 막는 근거로 쓰지 않는다(이 화면엔 발행 버튼 자체가 없다, PR2 몫).
type PublishingLimitState =
  | { status: 'loading' }
  | { status: 'ok'; quotaUsage: number; quotaTotal: number; checkedAt: string }
  | { status: 'failed' };

// N(페드루 PO, 2026-09-04 13:27Z·유나 지적) — 바이트 크기는 항상 MB로 나누던 자체
// formatMegabytes가 1MB 미만 값을 "0.0MB"로 뭉개(변환 결과가 사라진 것처럼 읽힘) 재구현
// 금지 규율(lib/storage/format.ts 헤더 주석 "파일 크기 포맷은 재구현 금지 → formatFileSize
// (file-node.tsx) 재사용")까지 어기고 있었다. 그 헬퍼로 교체 — B/KB/MB 자동 스케일.

// story #3428(T3-M·§13 3요소: 무엇이·얼마까지·지금 얼마) — CHANNEL_IMAGE_* 422/413의
// 부가 필드를 사람 말로 조립한다. api-error.ts는 labelKey를 일부러 비워 뒀다(kind별로
// 실리는 필드 집합이 달라 화면이 조립해야 한다 — CHANNEL_TEXT_TOO_LONG과 동형 관례).
function describeChannelImageError(info: SitePostApiErrorInfo, t: (key: string, values?: Record<string, string | number>) => string): string {
  switch (info.kind) {
    case 'image_unsupported_format':
      return t('channelPostsImageUnsupportedFormat', {
        contentType: info.imageContentType ?? '',
        allowed: (info.imageAllowedFormats ?? []).join(', '),
      });
    case 'image_too_large':
      return t('channelPostsImageTooLarge', {
        maxBytes: typeof info.imageMaxBytes === 'number' ? formatFileSize(info.imageMaxBytes) : '',
        sizeBytes: typeof info.imageSizeBytes === 'number' ? formatFileSize(info.imageSizeBytes) : '',
      });
    case 'image_aspect_ratio_exceeded':
      return t('channelPostsImageAspectRatioExceeded', {
        maxAspectRatio: info.imageMaxAspectRatio?.toFixed(1) ?? '',
        aspectRatio: info.imageAspectRatio?.toFixed(2) ?? '',
      });
    case 'image_conversion_failed':
      return t('channelPostsImageConversionFailed', {
        maxBytes: typeof info.imageMaxBytes === 'number' ? formatFileSize(info.imageMaxBytes) : '',
        finalBytes: typeof info.imageFinalBytes === 'number' ? formatFileSize(info.imageFinalBytes) : '',
      });
    case 'image_animated_unsupported':
      return t('channelPostsImageAnimatedUnsupported', { frameCount: info.imageFrameCount ?? '' });
    default:
      return info.humanMessageKey ? t(info.humanMessageKey) : (info.humanMessageFallback || t('errorChannelImageUploadFailed'));
  }
}

export default function ChannelPostEditPage() {
  const { orgId, role } = useDashboardContext();
  const params = useParams();
  const draftId = String(params.draftId);
  const t = useTranslations('content');
  const locale = useLocale();

  const [draft, setDraft] = useState<ChannelPostDraftDetail | null>(null);
  // story #3499 — draft.publication_id는 BE #3844 조각4 의존(additive, 미착지).
  const [insightSnapshots, setInsightSnapshots] = useState<InsightSnapshot[]>([]);
  useEffect(() => {
    if (!orgId || !draft?.publication_id) { setInsightSnapshots([]); return; }
    let cancelled = false;
    fetchWithAuth(`/api/organizations/${orgId}/publications/${draft.publication_id}/insights`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => { if (!cancelled) setInsightSnapshots(Array.isArray(body?.data) ? body.data : []); })
      .catch(() => { if (!cancelled) setInsightSnapshots([]); });
    return () => { cancelled = true; };
  }, [orgId, draft?.publication_id]);
  // story #3517(Phase2·FE, BE #3865 조각①, §22-2 삽입 지점 그라운딩) — 발행됨 오버레이
  // 안, InsightSnapshotBlock과 같은 조건(draft.publication_id 있을 때만)·같은 왕복
  // 패턴(insights 미러). 부수 데이터(§16-7 2부 원칙 그대로 — 3514/#3864 선례) — reject
  // 시에도 'error' 얼굴로 안전 착지, 화면 전체를 막지 않는다.
  const [commentsFace, setCommentsFace] = useState<CommentsFace>({ kind: 'uncollected' });
  const loadComments = useCallback(() => {
    if (!orgId || !draft?.publication_id) { setCommentsFace({ kind: 'uncollected' }); return; }
    let cancelled = false;
    fetchWithAuth(`/api/organizations/${orgId}/publications/${draft.publication_id}/comments`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (cancelled) return;
        const data = (body?.data ?? null) as RawCommentsResponse | null;
        if (!data) { setCommentsFace({ kind: 'error' }); return; }
        setCommentsFace(deriveCommentsFace(data));
      })
      .catch(() => { if (!cancelled) setCommentsFace({ kind: 'error' }); });
    return () => { cancelled = true; };
  }, [orgId, draft?.publication_id]);
  useEffect(() => loadComments(), [loadComments]);
  const [versions, setVersions] = useState<ChannelPostVersion[]>([]);
  const [maxTextLength, setMaxTextLength] = useState<number | null | undefined>(undefined);
  // story #3402 ④(AC9) — account_label(없으면 account_id)로 나가는 계정을 승인 카드에
  // 적는다. undefined="아직 모른다"(연결 조회 전/실패) — accountId 자체가 없다는 뜻은
  // 아니다(그 값은 findConnection이 못 찾은 경우에만 undefined로 남는다).
  const [accountLabel, setAccountLabel] = useState<string | undefined>(undefined);
  // story #3426 — undefined="연결 조회 전/실패, 아직 모른다"(§3-2와 같은 축) · 조회 성공하면
  // 연결의 can_unpublish/unpublish_blocked_reason 그대로.
  // story #3458 — connectionStatus 추가(같은 조회, 새 왕복 0).
  const [unpublishGate, setUnpublishGate] = useState<
    { canUnpublish: boolean; blockedReason: 'unsupported' | 'scope_insufficient' | null; connectionStatus: ChannelConnectionInfo['status'] } | undefined
  >(undefined);
  const [limit, setLimit] = useState<PublishingLimitState>({ status: 'loading' });
  // story #3500(BE #3498, PO 確定 2026-09-05 — BE 미착지, 계약만 고정) — 생성 비용
  // 한도 잔량(별도 non-blocking 왕복, limit과 동형 원칙)·상신 시 실을 예상 비용
  // 입력(선택, 문자열 상태 — 빈 문자열=body에 안 실음).
  const [genBudget, setGenBudget] = useState<GenerationBudgetState>({ status: 'loading' });
  const [estimatedCostInput, setEstimatedCostInput] = useState('');
  // doc a0da40c9 §19-8 — 422 배너는 별도 state(구조화된 4값+통화)로 렌더한다. submitResult
  // (일반 오류 배너)와 다른 자리 — 이 배너는 label+value 두 칸 목록이라 문자열 하나로
  // 뭉치면 §19-8이 요구하는 구조를 못 그린다.
  const [genBudgetExceeded, setGenBudgetExceeded] = useState<
    { limitMinor: number; spentMinor: number; estimatedCostMinor: number; remainingMinor: number; currency: GenerationBudgetCurrency } | null
  >(null);
  // PO REQUIRED②(2026-09-05, PR#3848 리뷰) — `currency ?? 'KRW'` 조립 제거(site_post
  // 상세와 동형 처방, generation-budget-indicator.tsx 참조).
  const generationBudgetUsable =
    genBudget.status === 'ok' && genBudget.limitMinor !== null && genBudget.currency !== null
    && genBudget.remainingMinor !== null && genBudget.spentMinor !== null;
  const generationBudgetCurrency: GenerationBudgetCurrency | null =
    genBudget.status === 'ok' ? genBudget.currency : null;
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  // story #3428(T3-M·§17-16) — 어댑터가 선언한 이미지 규격(연결 응답에서 읽음).
  // undefined="아직 모른다"(연결 조회 전/실패) — maxCount<=0과 동형으로 첨부 칸을
  // 그리지 않는다(둘 다 "모른다"와 "미지원"을 같은 쪽으로 fail-closed).
  const [imageSpec, setImageSpec] = useState<
    | {
        maxCount: number; formats: string[]; maxBytes: number; aspectMax: number;
        widthMin: number; widthMax: number; colorSpace: string;
      }
    | undefined
  >(undefined);
  const [imageUploadStatus, setImageUploadStatus] = useState<
    | { phase: 'idle' }
    | { phase: 'requesting_url' }
    | { phase: 'uploading' }
    | { phase: 'confirming' }
    | { phase: 'error'; text: string; raw?: string }
  >({ phase: 'idle' });
  // ②(유나 지적, 2026-09-04) — 실제 파일 선택은 hidden input이 하고, 화면엔 라벨 붙은
  // Button만 보인다(브라우저 기본 컨트롤 로케일 불일치 회피).
  const imageFileInputRef = useRef<HTMLInputElement>(null);

  const [text, setText] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{ type: 'success' | 'error'; text: string; raw?: string } | null>(null);
  // story #3472 2부(BE 3471/#3825, 유나 §16-7 정본 2026-09-05) — 초안 create/update
  // 응답과 상신 422 CONTENT_RULE_VIOLATION이 함께 채우는 하나의 목록. "필드 옆" 렌더
  // 단위가 이것 하나다 — 상신 422는 새 배너를 만들지 않고 이 state를 서버 응답으로
  // 갱신한다(§16-7 "상신 422는 새 배너를 만들지 않는다").
  const [violations, setViolations] = useState<ContentRuleViolation[]>([]);

  // story #3422 ②-d — 예약 상신 다이얼로그. serverError는 클라 검증 통과 뒤에도 상신
  // 사이 시각이 흘러 서버가 422로 거부하는 경로(parseScheduledAtServerError)만 담는다
  // — 다이얼로그가 안 닫혀 재선택 가능하게 유지한다.
  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false);
  const [scheduleServerError, setScheduleServerError] = useState<'past_or_invalid' | null>(null);

  // story #3517(Phase2·FE) — 「작업으로 전환」 다이얼로그. comment 자체가 open/close를
  // 겸한다(null=닫힘, 그 댓글=열림) — dialog와 별도 boolean state를 안 둔다(kanban의
  // story-detail-panel.tsx류 편집 다이얼로그와 동형 관례).
  const [convertToTaskComment, setConvertToTaskComment] = useState<CommentItem | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<
    { type: 'success'; gateId: string } | { type: 'error'; text: string; raw?: string; heldByDraftId?: string } | null
  >(null);

  // story #3402 PR2 ②-b — 발행(T7). confirm 다이얼로그 없음(site-posts와 동형 — 되돌릴 수
  // 없는 쪽은 발행 취소이지 발행 자체가 아니다, handleUnpublish만 ConfirmDialog를 쓴다).
  const [publishing, setPublishing] = useState(false);
  const [publishResult, setPublishResult] = useState<
    | { type: 'success' }
    | { type: 'scheduled'; scheduledAt?: string }
    | { type: 'error'; text: string; raw?: string; externalImpact?: ReturnType<typeof describeExternalImpact> }
    | null
  >(null);

  // story #3426 ①-c — 예약 취소·회수. 둘 다 되돌릴 수 없는(또는 되돌리기 번거로운) 상태
  // 전환이라 ConfirmDialog를 거친다(site-posts::handleUnpublish와 동형 — story #2416).
  const [cancelScheduledConfirmOpen, setCancelScheduledConfirmOpen] = useState(false);
  const [cancellingScheduled, setCancellingScheduled] = useState(false);
  // story #3454(유나 Design FAIL, PR#3801) — 8곳 중 이 state만 raw가 없었다. 같은
  // 패턴으로 마저 닫는다.
  const [cancelScheduledResult, setCancelScheduledResult] = useState<{ type: 'success' } | { type: 'error'; text: string; raw?: string } | null>(null);

  const [unpublishConfirmOpen, setUnpublishConfirmOpen] = useState(false);
  const [unpublishing, setUnpublishing] = useState(false);
  // story #3454(retryResult와 같은 발견 — 티켓 범위 밖이지만 같은 파일·같은 버그 종류라
  // 함께 고친다, PO 보고에 별도 표기) — 이 state도 raw 자체가 없었다.
  const [unpublishResult, setUnpublishResult] = useState<{ type: 'success' } | { type: 'error'; text: string; raw?: string } | null>(null);

  // story f061c1a3(#3422 AC3 잔여) — 실패 배지 「재시도」 클릭 배선. dead_letter·
  // needs_check 둘 다 같은 다이얼로그를 쓴다 — needs_check만 추가로 「확認했습니다」
  // 체크가 확認 버튼을 잠근다(AC2, 체크 前 비활성·후 활성).
  const [retryConfirmOpen, setRetryConfirmOpen] = useState(false);
  const [retryChecklistConfirmed, setRetryChecklistConfirmed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  // story #3454(유나 지적, PR#3798 Design review) — 다른 여섯 결과 state와 동형으로
  // raw를 담는다(§4-1 "원문을 접어서 함께 보존한다" — 이 state만 raw 자체가 없어서 재시도
  // 실패 시에만 원문이 안 남던 것을 맞춘다).
  const [retryResult, setRetryResult] = useState<{ type: 'success' } | { type: 'error'; text: string; raw?: string } | null>(null);

  useEffect(() => {
    if (!orgId || !draftId) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      setLoadError(false);
      try {
        const [draftRes, versionsRes] = await Promise.all([
          fetchWithAuth(`/api/organizations/${orgId}/channel-posts/drafts/${draftId}`),
          fetchWithAuth(`/api/organizations/${orgId}/channel-posts/drafts/${draftId}/versions`),
        ]);
        if (cancelled) return;
        if (!draftRes.ok || !versionsRes.ok) {
          setLoadError(true);
          return;
        }
        const draftJson = (await draftRes.json().catch(() => null)) as { data?: ChannelPostDraftDetail } | null;
        const versionsJson = (await versionsRes.json().catch(() => null)) as { data?: ChannelPostVersion[] } | null;
        const d = draftJson?.data;
        const list = versionsJson?.data ?? [];
        setDraft(d ?? null);
        // story #3514(doc a0da40c9, PO 確定 2026-09-05) — lint-on-read. 저장/상신
        // 응답에서만 갱신되던 위반 목록을 로드 시점에도 채운다 — "저장 없이" 위반
        // 목록·상신 비활성이 선다(§16-7을 읽기까지 넓힘). 계약 없으면(BE 미착지)
        // undefined → 빈 배열(지어내지 않는다).
        setViolations(d?.violations ?? []);
        setVersions(list);
        const latest = list[list.length - 1];
        if (latest) {
          setText(latest.text);
          setLinkUrl(latest.link_url ?? '');
        }
        if (d) {
          const connRes = await fetchWithAuth(`/api/organizations/${orgId}/channel-connections`);
          if (!cancelled && connRes.ok) {
            const connJson = (await connRes.json().catch(() => null)) as { data?: ChannelConnectionInfo[] } | null;
            const conn = connJson?.data?.find((c) => c.id === d.connection_id);
            // AC6 — 계약 필드 자체가 없거나 연결을 못 찾으면 "모른다"(undefined)로 남긴다.
            // 값이 명시적으로 null이면 "선언 안 함"(한도 미확認)으로 구별한다.
            setMaxTextLength(conn ? conn.max_text_length : undefined);
            // AC9 — account_label 없으면 account_id로 폴백(지어내지 않는다).
            if (conn) setAccountLabel(conn.account_label ?? conn.account_id);
            // story #3426 — can_unpublish/unpublish_blocked_reason은 draft가 아니라
            // 이 연결 응답에 실린다(그라운딩 확認) — 새 왕복을 만들지 않고 같은 응답에서 읽는다.
            if (conn) {
              setUnpublishGate({
                canUnpublish: conn.can_unpublish, blockedReason: conn.unpublish_blocked_reason, connectionStatus: conn.status,
              });
            }
            // story #3428(T3-M) — 이미지 규격(어댑터 성질) 그대로 읽는다(하드코딩 금지 축).
            if (conn) {
              setImageSpec({
                maxCount: conn.image_max_count, formats: conn.image_formats, maxBytes: conn.image_max_bytes,
                aspectMax: conn.image_aspect_max, widthMin: conn.image_width_min, widthMax: conn.image_width_max,
                // N(페드루 PO, 2026-09-04 13:27Z) — connection 응답에서 이미 읽던 필드가
                // imageSpec에 안 실려 규격 태그에 한 번도 안 나온 갭.
                colorSpace: conn.image_color_space,
              });
            }
          }

          // AC7 — 한도 잔량은 별도 왕복(휴먼 전용 엔드포인트, provider 실조회라 느릴 수
          // 있어 draft/versions 로드를 막지 않는다). 실패해도 화면 전체를 막지 않고
          // "조회 실패" 상태로만 남긴다(§3-2 "모른다를 다르다로 접지 않는다").
          fetchWithAuth(`/api/organizations/${orgId}/channel-connections/${d.connection_id}/publishing-limit`)
            .then(async (r) => {
              if (cancelled) return;
              if (!r.ok) {
                setLimit({ status: 'failed' });
                return;
              }
              const json = (await r.json().catch(() => null)) as
                { data?: { quota_usage: number; quota_total: number } } | null;
              if (!json?.data) {
                setLimit({ status: 'failed' });
                return;
              }
              setLimit({
                status: 'ok', quotaUsage: json.data.quota_usage, quotaTotal: json.data.quota_total,
                checkedAt: new Date().toISOString(),
              });
            })
            .catch(() => {
              if (!cancelled) setLimit({ status: 'failed' });
            });
        }
      } catch {
        if (!cancelled) setLoadError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [orgId, draftId]);

  // story #3500(BE #3498, PO 確定 2026-09-05 — BE 미착지, 계약만 고정) — 잔량은
  // 규칙과 별개 왕복(draft/versions 로드를 막지 않는다, `limit`과 동형 원칙).
  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    fetchWithAuth(`/api/organizations/${orgId}/generation-budget`)
      .then(async (r) => {
        if (cancelled) return;
        if (!r.ok) { setGenBudget({ status: 'failed' }); return; }
        const json = (await r.json().catch(() => null)) as
          | { data?: { limit_minor: number | null; spent_minor: number | null; remaining_minor: number | null; currency: 'KRW' | 'USD' | null; period: 'month' } }
          | null;
        if (!json?.data) { setGenBudget({ status: 'failed' }); return; }
        setGenBudget({
          status: 'ok',
          limitMinor: json.data.limit_minor,
          spentMinor: json.data.spent_minor,
          remainingMinor: json.data.remaining_minor,
          currency: json.data.currency,
          period: json.data.period,
        });
      })
      .catch(() => { if (!cancelled) setGenBudget({ status: 'failed' }); });
    return () => { cancelled = true; };
  }, [orgId]);

  const textLength = channelTextLength(text);
  // AC6 — 한도 미선언(null)이면 초과 판정 자체를 안 한다(지어내지 않는다, 상신은 막지 않음).
  const isOverLimit = typeof maxTextLength === 'number' && textLength > maxTextLength;
  // story #3472 2부(§16-7) — "강도는 하나다 — 편집 중에도 「이대로는 상신할 수
  // 없습니다」를 말한다"·"severity가 없는 것은 알고 줄인 것"(첫 슬라이스=기계 검사
  // 둘 다 차단). 지금 계약엔 warn이 없어 위반이 있으면 전부 차단.
  const hasBlockingViolations = violations.length > 0;

  const handleSave = async () => {
    if (!orgId || !draft || imageUploadInProgress) return;
    setSaving(true);
    setSaveMessage(null);
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgId}/channel-posts/drafts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          work_item_id: draft.work_item_id,
          connection_id: draft.connection_id,
          text,
          link_url: linkUrl.trim() || null,
        }),
      });
      if (res.ok) {
        setSaveMessage({ type: 'success', text: t('editSaved') });
        // story #3472 2부 — create 응답의 violations[]로 필드 옆 목록을 갱신한다(§16-7
        // "기본 처리는 필드 옆 목록을 서버 응답으로 갱신"). 계약에 없으면(BE 미착지) 빈
        // 배열 — 화면은 아무것도 지어내지 않는다.
        const json = (await res.json().catch(() => null)) as { data?: { violations?: ContentRuleViolation[] } } | null;
        setViolations(json?.data?.violations ?? []);
        const versionsRes = await fetchWithAuth(`/api/organizations/${orgId}/channel-posts/drafts/${draftId}/versions`);
        if (versionsRes.ok) {
          const versionsJson = (await versionsRes.json().catch(() => null)) as { data?: ChannelPostVersion[] } | null;
          if (versionsJson?.data) setVersions(versionsJson.data);
        }
      } else {
        const body = await res.json().catch(() => null);
        const info = parseSitePostApiError(body);
        setSaveMessage({
          type: 'error',
          text: info.humanMessageKey ? t(info.humanMessageKey) : (info.humanMessageFallback || t('editSaveFailed')),
          raw: info.raw,
        });
      }
    } catch {
      setSaveMessage({ type: 'error', text: t('editSaveFailed') });
    } finally {
      setSaving(false);
    }
  };

  // AC5 — 상신은 휴먼 전용이 아니다(actor_type 가드 없음) — 이 화면 자체는 휴먼만
  // 접근하므로 버튼 노출 자체엔 영향 없다. AC6 — 초과 상태면 버튼을 비활성화한다.
  const handleSubmitForApproval = async (scheduledAt?: string) => {
    if (!orgId || !draft || isOverLimit || hasBlockingViolations || imageUploadInProgress) return;
    const latest = versions[versions.length - 1];
    if (!latest) return;
    if (scheduledAt) setScheduleServerError(null);
    setSubmitting(true);
    setSubmitResult(null);
    setGenBudgetExceeded(null);
    try {
      // story #3500 — estimated_cost_minor는 값을 입력했을 때만 body에 실린다(빈
      // 문자열=선택 안 함, scheduled_at과 동형 조건부 포함 관례).
      const submitBody: { version_id: string; scheduled_at?: string; estimated_cost_minor?: number } = {
        version_id: latest.version_id,
      };
      if (scheduledAt) submitBody.scheduled_at = scheduledAt;
      // §19-1 — 입력은 큰단위(major), 서버로는 분단위(minor)만 보낸다. 변환은
      // generation-budget-indicator.tsx::majorToMinor 한 곳에서만. currency가
      // null이면 입력 자체가 안 그려져 이 값이 채워질 수 없다 — 방어적 재확認.
      if (estimatedCostInput !== '' && generationBudgetCurrency !== null) {
        submitBody.estimated_cost_minor = majorToMinor(Number(estimatedCostInput), generationBudgetCurrency);
      }
      const res = await fetchWithAuth(`/api/organizations/${orgId}/channel-posts/drafts/${draftId}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(submitBody),
      });
      if (res.ok) {
        if (scheduledAt) setScheduleDialogOpen(false);
        const json = (await res.json().catch(() => null)) as { data?: { gate_id?: string } } | null;
        const gateId = json?.data?.gate_id;
        if (gateId) {
          setSubmitResult({ type: 'success', gateId });
        } else {
          setSubmitResult({ type: 'error', text: t('submitFailed'), raw: JSON.stringify(json) });
        }
      } else {
        const body = await res.json().catch(() => null);
        // story #3472 2부(유나 §16-7) — "상신 422는 새 배너를 만들지 않는다". 위반은
        // 이미 필드 옆에 서 있던 것이라 여기서는 그 목록을 서버 응답으로 갱신만 하고
        // 끝낸다(submitResult 일반 오류 배너로 안 떨어뜨린다). "화면 밖 필드"·"화면에
        // 없던 새 위반" 두 예외 배너는 이번 슬라이스 범위 밖(후속).
        const ruleViolationBody = body as { error?: { code?: string; violations?: ContentRuleViolation[] } } | null;
        if (ruleViolationBody?.error?.code === 'CONTENT_RULE_VIOLATION') {
          setViolations(ruleViolationBody.error.violations ?? []);
          return;
        }
        // story #3422 ②-d(페드루 PO 지적 2026-09-04 10:49Z) — scheduled_at을 실은
        // 요청만 이 폴백을 본다(예약 아닌 상신에서 이 shape가 뜰 리 없다 — 그래도
        // 방어적으로 scheduledAt 유무로 먼저 좁힌다). 감지되면 다이얼로그를 안 닫고
        // 사람 문장만 갱신 — submitResult(하단 일반 오류 배너)는 안 건드린다.
        if (scheduledAt) {
          const scheduleError = parseScheduledAtServerError(body);
          if (scheduleError) {
            setScheduleServerError(scheduleError);
            return;
          }
        }
        const info = parseSitePostApiError(body);
        // story #3402·PR#3764/#3767 — CHANNEL_POST_GATE_ALREADY_HELD. site와 kind는
        // 공유하되 slug/lang이 없다(채널 포스트 모델 자체에 title이 없다) — 페드루 PO
        // 정정(2026-09-04 02:00Z, doc §5 12행 정본): ①best-effort로 상대 초안
        // GET drafts/{holding_draft_id}의 text_preview(story #3767, 곧 착지·필드
        // 부재면 자연히 ②로 떨어진다)를 먼저 시도 ②실패/부재 시 "Threads 초안
        // ····<4자>" 폴백. **4자는 holding_draft_id 앞 4자**다(connection_id는 그
        // 초안을 쥔 다른 초안 전부가 같은 값이라 식별력이 0 — 링크 대상과 같은
        // 식별자를 써야 사람이 "이 문구가 저 링크"라고 알 수 있다). ⛔"합치기"류
        // 문구는 쓰지 않는다(제품에 없는 동작 — doc §5 각주 명시).
        if (info.kind === 'gate_already_held' && info.heldByDraftId) {
          const holdingDraftId = info.heldByDraftId;
          const holdingChannelLabel = info.heldByChannel ? channelLabel(info.heldByChannel, t) : t('channelThreads');
          let holdingLabel = `${holdingChannelLabel} 초안 ····${holdingDraftId.slice(0, 4)}`;
          try {
            const holdingRes = await fetchWithAuth(`/api/organizations/${orgId}/channel-posts/drafts/${holdingDraftId}`);
            if (holdingRes.ok) {
              const holdingJson = (await holdingRes.json().catch(() => null)) as
                { data?: { text_preview?: string | null } } | null;
              const preview = holdingJson?.data?.text_preview;
              if (preview) holdingLabel = preview;
            }
          } catch {
            // best-effort — 조회 실패는 위 폴백 문구로 graceful(지어내지 않되 화면을
            // 막지도 않는다, gates/[id]/page.tsx memberNames 관례와 동형).
          }
          setSubmitResult({
            type: 'error',
            text: holdingLabel,
            raw: info.raw,
            heldByDraftId: holdingDraftId,
          });
        } else if (
          info.kind === 'generation_budget_exceeded'
          && typeof info.limitMinor === 'number' && typeof info.spentMinor === 'number'
          && typeof info.estimatedCostMinor === 'number' && typeof info.remainingMinor === 'number'
          // PO REQUIRED②(2026-09-05) — 422 detail엔 currency가 없다(4값뿐). genBudget
          // GET이 실패/불완전(null)이면 통화를 모른 채 그릴 수 없어 구조화 배너를
          // 접고 일반 에러 문구로 폴백한다('KRW' 추정 안 함).
          && generationBudgetCurrency !== null
        ) {
          // doc a0da40c9 §19-8(디자인 유나 確定) — 전용 구조화 배너(사실 문장→4값
          // 두 칸 목록→행동 문장, generic submitResult 텍스트 배너와 다른 자리).
          // 입력값은 지우지 않는다(ScheduleAtDialog의 "서버 오류 시 입력 유지" 관례와
          // 동형 — 사람이 다시 타이핑하지 않아도 되게).
          setGenBudgetExceeded({
            limitMinor: info.limitMinor, spentMinor: info.spentMinor,
            estimatedCostMinor: info.estimatedCostMinor, remainingMinor: info.remainingMinor,
            currency: generationBudgetCurrency,
          });
        } else {
          setSubmitResult({
            type: 'error',
            text: info.humanMessageKey ? t(info.humanMessageKey) : (info.humanMessageFallback || t('submitFailed')),
            raw: info.raw,
          });
        }
      }
    } catch {
      setSubmitResult({ type: 'error', text: t('submitFailed') });
    } finally {
      setSubmitting(false);
    }
  };

  // story #3428(T3-M) — 이미지 첨부 2단계(발급→PUT→confirm). PUT 자체는 fetchWithAuth를
  // 안 쓴다(서명 URL 자체가 인증이라 우리 Authorization 헤더를 붙이면 GCS 서명이 깨진다
  // — avatar_upload.py 소비부와 동형 관례). confirm 성공은 새 버전을 만들므로(BE
  // 620beefc) draft의 이미지 필드만 그 자리에서 병합하고(handlePublish와 동형 — 응답
  // 필드만 병합, 재조회 안 함) versions만 재조회한다(text/link_url 입력값은 안 건드려
  // — 사용자가 아직 저장 안 한 편집 중 텍스트를 잃지 않는다).
  const handleImageFileSelected = async (file: File) => {
    if (!orgId || !draft) return;
    setImageUploadStatus({ phase: 'requesting_url' });
    try {
      const urlRes = await fetchWithAuth(
        `/api/organizations/${orgId}/channel-posts/drafts/${draftId}/assets/upload-url`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content_type: file.type }) },
      );
      if (!urlRes.ok) {
        const body = await urlRes.json().catch(() => null);
        const info = parseSitePostApiError(body);
        setImageUploadStatus({ phase: 'error', text: describeChannelImageError(info, t), raw: info.raw });
        return;
      }
      const urlJson = (await urlRes.json().catch(() => null)) as
        { data?: { upload_url: string; object_path: string; required_put_headers: Record<string, string> } } | null;
      const uploadInfo = urlJson?.data;
      if (!uploadInfo) {
        setImageUploadStatus({ phase: 'error', text: t('errorChannelImageUploadFailed') });
        return;
      }

      setImageUploadStatus({ phase: 'uploading' });
      const putRes = await fetch(uploadInfo.upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': file.type, ...uploadInfo.required_put_headers },
        body: file,
      });
      if (!putRes.ok) {
        setImageUploadStatus({ phase: 'error', text: t('errorChannelImageUploadFailed') });
        return;
      }

      setImageUploadStatus({ phase: 'confirming' });
      const confirmRes = await fetchWithAuth(
        `/api/organizations/${orgId}/channel-posts/drafts/${draftId}/assets/confirm`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ object_path: uploadInfo.object_path }) },
      );
      if (!confirmRes.ok) {
        const body = await confirmRes.json().catch(() => null);
        const info = parseSitePostApiError(body);
        setImageUploadStatus({ phase: 'error', text: describeChannelImageError(info, t), raw: info.raw });
        return;
      }
      const confirmJson = (await confirmRes.json().catch(() => null)) as
        {
          data?: {
            version: number; original_width: number; original_bytes: number;
            final_width: number; final_bytes: number; was_converted: boolean; image_url: string | null;
          };
        } | null;
      const image = confirmJson?.data;
      if (!image) {
        setImageUploadStatus({ phase: 'error', text: t('errorChannelImageUploadFailed') });
        return;
      }
      // B1(페드루 PO, 2026-09-04 13:26Z) — confirm이 새 버전을 만들며 서버가
      // _reseal_gate_on_new_version(backend/app/services/channel_posts.py)으로 approved
      // 게이트를 재오픈+reapproval_required=true로 바꾼다. 이미지 필드만 로컬 병합하면
      // gate_status/reapproval_required가 낡아 화면은 "승인됨·발행 가능"으로 남는데
      // 서버는 재승인을 요구한다(눌러야 서버가 거부) — 단건 GET(PR#3788)으로 서버 값을
      // 통째로 교체한다. text/linkUrl은 별도 state라 입력 중이던 내용은 안 건드린다.
      const [draftRes, versionsRes] = await Promise.all([
        fetchWithAuth(`/api/organizations/${orgId}/channel-posts/drafts/${draftId}`),
        fetchWithAuth(`/api/organizations/${orgId}/channel-posts/drafts/${draftId}/versions`),
      ]);
      if (draftRes.ok) {
        const draftJson = (await draftRes.json().catch(() => null)) as { data?: ChannelPostDraftDetail } | null;
        if (draftJson?.data) setDraft(draftJson.data);
      }
      if (versionsRes.ok) {
        const versionsJson = (await versionsRes.json().catch(() => null)) as { data?: ChannelPostVersion[] } | null;
        if (versionsJson?.data) setVersions(versionsJson.data);
      }
      setImageUploadStatus({ phase: 'idle' });
    } catch {
      setImageUploadStatus({ phase: 'error', text: t('errorChannelImageUploadFailed') });
    }
  };

  // story #3402 PR2 ②-b(T7·AC5·AC10) — 발행. draft 상태를 재로드하지 않고 성공 응답
  // {permalink, external_id, published_at, version_id}(story f8f7cb0f 계약)을 그 자리에서
  // 병합한다 — site-posts처럼 별도 loadGate/loadPublication 훅이 없다(단건 GET 하나가
  // 이미 게이트+발행 상태를 같이 준다, story #3394/#3403 설계). publication_status를
  // 'published'로 직접 세팅하지 않는 이유: 서버가 "최신 버전"과 "가장 최근 published"
  // 두 축을 조인 축을 다르게 계산하므로(§4-2, story #3394 AC2) 화면이 그 판정을 흉내내지
  // 않는다 — 성공 응답 필드만 병합하고, 진짜 publication_status는 다음 로드/새로고침이
  // 정직하게 채운다(지어내지 않는다).
  const handlePublish = async () => {
    if (!orgId || !draft || !canPublish || blockedByCommandInFlight) return;
    setPublishing(true);
    setPublishResult(null);
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgId}/channel-posts/drafts/${draftId}/publish`, { method: 'POST' });
      if (res.ok) {
        const json = (await res.json().catch(() => null)) as
          { data?: { permalink?: string; external_id?: string; published_at?: string; scheduled?: boolean; scheduled_at?: string } } | null;
        const { permalink, external_id, published_at, scheduled, scheduled_at } = json?.data ?? {};
        // story #3414(PR#3769, 아직 리뷰중 — 계약은 그 PR 스키마 기준) — scheduled=true면
        // 이 요청은 command만 만들고 실제 발행은 워커가 나중에 한다. permalink/
        // published_at 셋 다 null인 게 정상이라, 그 null을 "발행됨"으로 그리면 안 된다
        // (모르는 것을 아는 것처럼 안 보여준다 — 이 파일 전체를 관통하는 AC2 규율과 같은
        // 축). scheduled 분기를 permalink 존재 분기보다 먼저 검사한다.
        if (scheduled) {
          setPublishResult({ type: 'scheduled', scheduledAt: scheduled_at });
        } else if (permalink && published_at) {
          setPublishResult({ type: 'success' });
          setDraft((prev) => prev && { ...prev, permalink, external_id, published_at, publication_status: 'published' });
        } else {
          setPublishResult({ type: 'error', text: t('publishFailed'), raw: JSON.stringify(json) });
        }
      } else {
        const body = await res.json().catch(() => null);
        const info = parseSitePostApiError(body);
        // story #3402 PR2 ②-c(AC10) — CHANNEL_TEXT_TOO_LONG·CHANNEL_RATE_LIMITED는
        // api-error.ts가 max_length/current_length·reset_at을 실어만 오고 문구 조립은
        // 소비부 몫으로 남겨 둔 코드다(doc §5 표 — 「500자 한도인데 517자입니다」·
        // 「내일 09:00 이후 가능합니다」는 값을 실제로 보간해야 하는 문장이라 정적
        // 번역키 하나로 못 담는다). 나머지 코드는 기존 humanMessageKey/fallback 체인
        // 그대로.
        const text = info.kind === 'text_too_long' && info.maxLength != null && info.currentLength != null
          ? t('channelPostsTextTooLong', { max: info.maxLength, current: info.currentLength })
          : info.kind === 'rate_limited' && info.resetAt
            ? t('channelPostsRateLimitedUntil', { time: formatScheduledAt(info.resetAt, displayTimezone).display })
            : info.humanMessageKey ? t(info.humanMessageKey) : (info.humanMessageFallback || t('publishFailed'));
        // story #3402 AC11(doc §5-1) — "막혔다"(왜, text)와 "밖으로 나갔다"(externalImpact)
        // 는 뭉치면 안 되는 별개 사실이다. 페드루 PO 블로커 판정(2026-09-04 06:17Z) —
        // 판정 축은 http_status 숫자가 아니라 info.kind다(500/503/504·BFF 400·미지
        // 코드는 parseSitePostApiError가 이미 kind='unknown'으로 fail-closed해 둠 —
        // describeExternalImpact가 그 kind를 그대로 읽어 "모른다"를 "안 나갔다"로
        // 단정하지 않는다).
        setPublishResult({ type: 'error', text, raw: info.raw, externalImpact: describeExternalImpact(info.kind) });
      }
    } catch {
      // 네트워크 예외(fetch 자체가 throw) — 요청이 실제로 Threads까지 갔는지 여부를
      // 이 지점에서 알 수 없다(전송 도중 끊겼을 수도, 응답만 못 받았을 수도 있다) —
      // 'unknown'으로 fail-closed(위와 같은 축).
      setPublishResult({ type: 'error', text: t('publishFailed'), externalImpact: 'unknown' });
    } finally {
      setPublishing(false);
    }
  };

  // story #3426 ①-c(BE #3419) — 예약 취소. 성공하면 command_status를 로컬로 'cancelled'
  // 로 갱신(리로드 없이, §17-10 "취소됨" 오버레이) — doc AC4. 실패는 ①-d가 채운 오류
  // 6종 labelKey(사람 말) 체인을 통과한다 — PUBLICATION_COMMAND_NOT_CANCELLABLE만
  // current_status를 실어 조립(아래).
  const handleCancelScheduled = async () => {
    if (!orgId) return;
    setCancelScheduledConfirmOpen(false);
    setCancellingScheduled(true);
    setCancelScheduledResult(null);
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgId}/channel-posts/drafts/${draftId}/cancel-scheduled`, { method: 'POST' });
      if (res.ok) {
        setCancelScheduledResult({ type: 'success' });
        setDraft((prev) => prev && { ...prev, command_status: 'cancelled' });
      } else {
        const body = await res.json().catch(() => null);
        const info = parseSitePostApiError(body);
        // story #3426 ①-d — PUBLICATION_COMMAND_NOT_CANCELLABLE은 current_status를 실어
        // "이미 {status} 상태입니다"를 조립한다(labelKey는 일부러 비움, TEXT_TOO_LONG과
        // 같은 패턴). §17-10①의 한글 라벨표(대기 중/보내는 중/…)로 옮기는 건 이 조각
        // 스코프 밖 — 지금은 서버 enum 값을 그대로 보간(레이스에서만 뜨는 방어적 경로라
        // 드묾, 후속에서 라벨 매핑 추가 가능).
        const text = info.kind === 'command_not_cancellable' && info.currentStatus
          ? t('channelPostsCommandNotCancellable', { status: info.currentStatus })
          : info.humanMessageKey ? t(info.humanMessageKey) : (info.humanMessageFallback || t('channelPostsCancelScheduledFailed'));
        setCancelScheduledResult({ type: 'error', text, raw: info.raw });
      }
    } catch {
      setCancelScheduledResult({ type: 'error', text: t('channelPostsCancelScheduledFailed') });
    } finally {
      setCancellingScheduled(false);
    }
  };

  // story #3426 ①-c(BE #3419, 페드루 PO 정정 2026-09-04 08:40Z) — 회수(Threads 실 삭제,
  // 되돌릴 수 없다). 성공하면 서버가 다음 로드에서 줄 값과 같은 모양으로 로컬을 미러한다
  // — publication_status='unpublished'·published_at=null·permalink=null(아래), 오버레이
  // "회수됨"이 뜬다(doc §17-10②). "배너만"은 반쪽짜리였다 — 지금은 5상태 파생과
  // 정확히 같은 값으로 갱신한다(지어내지 않는다).
  const handleUnpublish = async () => {
    if (!orgId) return;
    setUnpublishConfirmOpen(false);
    setUnpublishing(true);
    setUnpublishResult(null);
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgId}/channel-posts/drafts/${draftId}/unpublish`, { method: 'POST' });
      if (res.ok) {
        // 페드루 PO 정정(2026-09-04 08:40Z) — 회수는 «별도 설계»가 아니라 서버 의미를
        // 그대로 미러하면 정해진다: 다음 로드에서 서버가 줄 값과 같은 모양으로 로컬을
        // 맞춘다(publication_status='unpublished'·published_at=null·permalink=null,
        // external_id는 응답 값을 그대로 — 보존이 아니라 응답이 주는 값 사용).
        const body = (await res.json().catch(() => null)) as { data?: { external_id?: string | null } } | null;
        setUnpublishResult({ type: 'success' });
        setDraft((prev) => prev && {
          ...prev, publication_status: 'unpublished', published_at: null, permalink: null,
          external_id: body?.data?.external_id ?? null,
        });
      } else {
        const body = await res.json().catch(() => null);
        const info = parseSitePostApiError(body);
        // story #3426 ①-d(doc §17-11) — CHANNEL_SCOPE_INSUFFICIENT는 편집 화면이 이미
        // connection 응답(unpublish_blocked_reason)으로 버튼을 막아 두는 정상 경로라
        // 여기 오는 건 레이스(그 사이 스코프가 바뀜) 방어다 — 같은 §17-11 role 분기
        // 정본 문구를 그대로 재사용(labelKey는 비워 둠, KNOWN_ERRORS 주석 참고).
        // story #3458 — channelPostsUnpublishScopeInsufficientOwner엔 이제 <link> 태그가
        // 있다(버튼 밖 사유줄 자리는 t.rich로 실 링크를 그린다) — 여기는 plain string
        // 상태(unpublishResult.text)라 JSX를 못 담는다. plain t()는 태그를 못 지워
        // FORMATTING_ERROR로 키 이름 자체가 새 버린다(실측) — t.markup으로 태그만
        // 벗기고 문구는 그대로 얻는다(next-intl 정식 API, 결과가 string).
        const text = info.kind === 'scope_insufficient'
          ? (role === 'owner'
            ? t.markup('channelPostsUnpublishScopeInsufficientOwner', { link: (chunks) => chunks })
            : t('channelPostsUnpublishScopeInsufficientNonOwner'))
          : info.humanMessageKey ? t(info.humanMessageKey) : (info.humanMessageFallback || t('channelPostsUnpublishFailed'));
        setUnpublishResult({ type: 'error', text, raw: info.raw });
      }
    } catch {
      setUnpublishResult({ type: 'error', text: t('channelPostsUnpublishFailed') });
    } finally {
      setUnpublishing(false);
    }
  };

  // story f061c1a3(#3422 AC3 잔여) — dead_letter 수동 재시도·needs_check 2단계 확認 뒤
  // 재시도. 성공하면 로컬로 짐작해 만들지 않고 단건 GET을 다시 불러 서버가 낸
  // command_status(보통 pending)로 배지를 갱신한다(§3-2 "지어내지 않는다"와 같은 축 —
  // B1(#3428)의 confirm 후 재조회 처방과 동형). 403(HUMAN_ONLY)·404(재시도 대상
  // 아님)는 서버 문장을 그대로 보인다(BFF가 삼키지 않는다).
  const handleRetry = async () => {
    if (!orgId || !draft?.command_id) return;
    setRetrying(true);
    setRetryResult(null);
    try {
      const res = await fetchWithAuth(
        `/api/organizations/${orgId}/channel-posts/publication-commands/${draft.command_id}/retry`, { method: 'POST' },
      );
      if (res.ok) {
        setRetryConfirmOpen(false);
        setRetryResult({ type: 'success' });
        const draftRes = await fetchWithAuth(`/api/organizations/${orgId}/channel-posts/drafts/${draftId}`);
        if (draftRes.ok) {
          const draftJson = (await draftRes.json().catch(() => null)) as { data?: ChannelPostDraftDetail } | null;
          if (draftJson?.data) setDraft(draftJson.data);
        }
      } else {
        const body = await res.json().catch(() => null);
        const info = parseSitePostApiError(body);
        setRetryResult({
          type: 'error',
          text: info.humanMessageKey ? t(info.humanMessageKey) : (info.humanMessageFallback || t('channelPostsRetryFailed')),
          raw: info.raw,
        });
      }
    } catch {
      setRetryResult({ type: 'error', text: t('channelPostsRetryFailed') });
    } finally {
      setRetrying(false);
    }
  };

  if (loading) {
    return <div className="mx-auto w-full max-w-2xl space-y-4 p-6" data-testid="channel-post-edit-loading" />;
  }
  if (loadError || !draft) {
    return (
      <div className="mx-auto w-full max-w-2xl p-6">
        <Alert variant="destructive" role="alert">
          <AlertDescription>{t('editLoadFailed')}</AlertDescription>
        </Alert>
      </div>
    );
  }

  // 카디르 QA(2026-09-04, 유나 정밀화) — 승인 카드가 5상태를 raw gate_status로 직접
  // 인라인 삼항 판정하면 목록(page.tsx, deriveChannelPostView 사용)과 5상태 파생이
  // 두 벌이 된다(같은 값을 두 곳에서 각자 만들면 하나만 고쳐질 위험). 목록과 똑같이
  // deriveChannelPostView를 통과시켜 AC2(hasPublishedSitePost===undefined일 때 status
  // 자체를 비우는 fail-safe)가 편집 화면에도 그대로 따라오게 한다.
  //
  // ⚠️실측 함정(자체 발견, 테스트가 잡음) — `gateStatus`를 "pending/approved/rejected가
  // 아니면 undefined"로만 매핑하면 "키가 아예 없다"(모른다)와 "gate_status===null"(진짜
  // 게이트 없음)이 똑같이 undefined가 되어 deriveContentPostStatus가 둘 다 'draft'로
  // 뭉갠다 — AC2가 지키려는 바로 그 구별이 여기서 사라진다. 목록(page.tsx)의
  // hasGateContract 가드와 동형으로, 키 자체가 없으면 파생을 아예 부르지 않는다.
  const hasGateContract = 'gate_status' in draft;
  const view = hasGateContract
    ? deriveChannelPostView({
        gateStatus: draft.gate_status === 'pending' || draft.gate_status === 'approved' || draft.gate_status === 'rejected'
          ? draft.gate_status : undefined,
        reapprovalRequired: draft.reapproval_required ?? undefined,
        sealedBodySha256: draft.sealed_content_sha256 ?? undefined,
        currentBodySha256: draft.body_sha256,
        // 페드루 PO 리뷰 nit(2026-09-04) 조사 중 자체 발견 — published_body_sha256이
        // 인터페이스엔 있었는데 view 계산에 실제로 안 넘어가고 있었다. 그러면
        // isRepublish(재승인 뒤 재발행 CTA)가 이 화면에서 절대 안 켜진다(hasUnpublishedApproval
        // 이 input.publishedBodySha256!==undefined를 요구하는데 항상 undefined로 들어갔으므로).
        publishedBodySha256: draft.published_body_sha256 ?? undefined,
        publicationStatus: draft.publication_status ?? undefined,
        errorCode: draft.error_code,
        publishedAt: 'published_at' in draft ? draft.published_at : undefined,
      })
    : { status: undefined, publishable: false, partialSuccess: false, publicationFailed: false, errorCode: undefined, unpublished: false, isRepublish: undefined, blockedReason: undefined };

  // story #3402 PR2 ②-a(doc §5·AC5) — 발행/발행 취소 버튼 게이팅(API 배선은 ②-b).
  // canPublish는 site-posts(content/[draftId]/page.tsx::canPublish)와 동형으로 role
  // 제약이 아니라 view.publishable(업무 상태) 그대로다 — "승인된 최신 버전에서만
  // 발행할 수 있다"는 판단은 게이트/봉인 일치 여부이지 누구인지가 아니다. canUnpublish
  // 만 site와 동일하게 role===owner|admin으로 좁힌다(발행 취소는 더 무거운 되돌릴 수
  // 없는 행동 — settings/page.tsx·org-members-section.tsx와 같은 role 소스 재사용,
  // 새 조회 안 만듦). 이 화면 자체가 사람 전용(에이전트에게 화면 없음, AC14)이라
  // "휴먼 게이팅"의 실체는 이 owner/admin 세분화다.
  const canPublish = view.publishable;
  const canUnpublish = role === 'owner' || role === 'admin';

  // story #3426(BE #3419, doc §17-10/§17-11) — 예약 취소는 command_status가 대기·멈춤
  // 상태일 때만(그 외는 이미 나갔거나 끝난 것 — 취소할 대상이 없다). role 게이팅은
  // canUnpublish와 같은 축(owner/admin — 되돌릴 수 있는 파괴적 전환이라 발행보다 한 단계
  // 더 좁다, cancel-scheduled BFF 그라운딩 그대로).
  const cancellableCommandStatuses = new Set(['pending', 'blocked', 'dead_letter']);
  const showCancelScheduled = !!draft.command_status && cancellableCommandStatuses.has(draft.command_status);
  const canCancelScheduled = canUnpublish;

  // 회수 버튼 — 발행됨 상태 + 연결이 이 채널의 회수를 지원(can_unpublish) + 연결
  // «상태»가 active(story #3458 — 토큰 만료 등은 can_unpublish와 다른 축, 정본
  // 3653a18c §3) + role 게이팅. unpublishGate===undefined(연결 조회 전/실패)면
  // "모른다"로 두고 버튼을 비활성화한다(§3-2와 같은 축 — 모르는 것을 근거로 허용하지
  // 않는다, fail-closed).
  const showUnpublish = draft.publication_status === 'published';
  const canUnpublishNow = canUnpublish && unpublishGate?.canUnpublish === true && unpublishGate?.connectionStatus === 'active';

  // story #3422 B4(페드루 PO, 2026-09-04 13:26Z, code-review "auto_retry 아래 발행
  // 버튼 활성"과 같은 자리) — command_status가 pending(자동 재시도 큐에 있음, awaiting_
  // container 포함)·blocked(연결 문제)면 새 발행/예약 상신을 막는다 — 이미 진행 중이거나
  // 고쳐야 할 것이 따로 있는데 사람이 또 시도하면 서버와 경합하거나 헛수고다.
  // dead_letter는 이 집합에 일부러 안 넣는다 — 재시도 «클릭» 배선(story f061c1a3, BE
  // command_id 노출 뒤) 前까지는 발행 버튼이 dead_letter의 유일한 수동 재시도 경로다
  // (지금 막으면 아예 되살릴 방법이 없어진다).
  const commandInFlightBlocksNewAttempt = new Set(['pending', 'blocked']);
  const blockedByCommandInFlight = !!draft.command_status && commandInFlightBlocksNewAttempt.has(draft.command_status);
  // 유나 재판정(2026-09-04 13:37Z) — pending·blocked를 한 문장에 묶으면 절반은 틀린
  // 지시가 된다("기다리세요"는 blocked에, "연결을 확인하세요"는 pending에 안 맞는다).
  // command_status로 정확히 갈라 서로 다른 문장을 낸다.
  const commandInFlightReasonKey = draft.command_status === 'blocked'
    ? 'channelPostsCommandInFlightReasonBlocked' : 'channelPostsCommandInFlightReasonPending';

  // story #3422 B3(페드루 PO, 2026-09-04 13:14Z) — FailureActionBadge가 정의만 있고
  // 이 화면엔 mount 안 돼 있던 갭(#3422 AC3). deriveFailureAction 입력은 목록/캘린더와
  // 동형(failure-action.ts 우선순위 진리표 그대로 재사용 — 화면이 갈래를 다시 안 짠다).
  const failureAction = deriveFailureAction({
    commandStatus: draft.command_status as CommandStatus | null | undefined,
    failureKind: draft.failure_kind,
    nextRetryAt: draft.next_retry_at,
    reasonCode: draft.command_reason_code,
    processingKind: draft.processing_kind,
  });
  const displayTimezone = resolveDisplayTimezone().tz;

  // B2(페드루 PO, 2026-09-04 13:27Z·code-review 지적) — 이미지 업로드가 confirm까지
  // 끝나기 전에 저장/상신을 누르면 두 흐름이 독립적으로 각자 새 버전을 만들어 경합한다
  // (나중에 끝나는 재조회가 먼저 것을 조용히 덮어써 이미지 첨부나 텍스트 수정이 사라진
  // 것처럼 보인다). 업로드가 진행 중인 동안은 저장/즉시 상신/예약 상신을 막는다.
  const imageUploadInProgress = imageUploadStatus.phase === 'requesting_url'
    || imageUploadStatus.phase === 'uploading' || imageUploadStatus.phase === 'confirming';

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6 p-6">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold text-foreground">{t('editTitle')}</h1>
          {/* story f30da19a AC5 — T3(상세 머리). */}
          {isSandboxChannelDraft(draft.channel) ? <SandboxTestBadge /> : null}
        </div>
        <p className="text-sm text-muted-foreground">
          {channelLabel(draft.channel, t)} · v{draft.current_version}
        </p>
        {/* story 15e481ce(#3453 AC2, 유나 §14-2 안전 표기) — "원문" 단정이 아니라 "같은
            스토리의 글". source_content_item_id 없으면(정상값) 이 줄 자체를 안 그린다.
            #3457 후속(BE #3817 착지분) — source_title이 이제 이 응답에 직접 실려 별도
            왕복이 없다.
            §11-5 staleness 배지(유나 정본 2026-09-04 20:57Z, #3453 AC3 후속 페드루 PO
            確定 2026-09-05로 판정 이관) — 이 줄 옆에만(칩 열이 아니라, "원문 줄 없는데
            배지만"이 구조적으로 안 나오게). source_changed는 서버가 이미 판정한 값만
            본다(true일 때만 렌더 — null/false는 "모른다"·"안 바뀜" 둘 다 무배지).
            문구는 발행 상태로 갈린다(유나 §14-4 — 발행됨에 "바뀌었습니다"만 적으면
            고치려 든다, 기록형 문구로): publication_status==='published'면
            channelPostsSourceChangedBadgePublished(「만들 때 판 그대로」류 아니라
            그 반대 — 판이 바뀐 기록), 그 외 기존 channelPostsSourceChangedBadge. */}
        {draft.source_content_item_id && draft.source_title ? (
          <p className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground" data-testid="channel-post-source-link">
            <span>
              {t('channelPostsSourceLabel')}{' '}
              <Link href={`/content/${draft.source_content_item_id}`} className="underline">
                {t('channelPostsSourceLinkText', { title: draft.source_title })}
              </Link>
            </span>
            {draft.source_changed === true ? (
              <span
                className="inline-flex items-center rounded-full border border-border px-1.5 py-0.5 text-xs text-muted-foreground"
                data-testid="channel-post-source-changed-badge"
              >
                {draft.publication_status === 'published'
                  ? t('channelPostsSourceChangedBadgePublished')
                  : t('channelPostsSourceChangedBadge')}
              </span>
            ) : null}
          </p>
        ) : null}
      </div>

      {/* story #3402 ④ — 승인 카드(T5/T6). AC8(UTM 미리보기)·AC9(계정 표시)·AC7(한도
          잔량, 조회 실패도 상태). 게이트 상태는 목록과 같은 파생 함수(deriveChannelPostView,
          위 view)를 그대로 재사용 — 5상태 라벨도 post-status.ts::contentPostStatusLabelKey
          (StatusChip과 동일 출처)를 그대로 쓴다(같은 개념을 두 벌 번역키로 안 나눈다). */}
      <div className="space-y-2 rounded-md border border-border p-4 text-sm" data-testid="channel-post-approval-card">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">{t('channelPostsApprovalStatusLabel')}</span>
          <span data-testid="channel-post-gate-status">
            {/* AC2 — view.status===undefined는 "모른다"(계약 필드 부재 등) — 「—」로
                구별해 「상신 전」(진짜 게이트 없음)과 섞이지 않게 한다. */}
            {view.status === undefined ? t('originAuthorUnknown') : t(contentPostStatusLabelKey(view.status))}
          </span>
        </div>
        {/* B3(페드루 PO) — 실패 배지는 칩(위 상태 줄) 바로 아래(§17-2 오버레이 규율).
            failureAction===undefined면(정상 대기·완료 등) 아예 안 그린다. story
            f061c1a3 — onRetryClick은 확認 다이얼로그를 여는 것까지만(실제 BFF 호출은
            다이얼로그의 onConfirm=handleRetry). dead_letter·needs_check가 아니면 배지가
            버튼 자체를 안 그려 이 콜백은 안 쓰인다. */}
        {failureAction ? (
          <FailureActionBadge
            action={failureAction} displayTimezone={displayTimezone}
            onRetryClick={() => { setRetryChecklistConfirmed(false); setRetryConfirmOpen(true); }}
          />
        ) : null}
        <ConfirmDialog
          open={retryConfirmOpen}
          onOpenChange={(next) => { setRetryConfirmOpen(next); if (!next) setRetryChecklistConfirmed(false); }}
          title={t('channelPostsRetryConfirmTitle')}
          description={(
            // 카디르 QA①·유나 §8과 동형 — 「무엇이·되돌릴 수 있나」는 별도 노드(§17-13).
            <>
              <span className="block" data-testid="channel-post-retry-confirm-what">
                {failureAction?.kind === 'needs_check' ? t('channelPostsRetryConfirmWhatNeedsCheck') : t('channelPostsRetryConfirmWhatDeadLetter')}
              </span>
              <span className="block" data-testid="channel-post-retry-confirm-reversible">{t('channelPostsRetryConfirmReversible')}</span>
              {/* AC2 — needs_check만 2단계: 체크 前엔 확認 버튼 비활성. */}
              {failureAction?.kind === 'needs_check' ? (
                <label className="mt-2 flex items-center gap-2 text-sm text-foreground">
                  <input
                    type="checkbox" checked={retryChecklistConfirmed}
                    onChange={(e) => setRetryChecklistConfirmed(e.target.checked)}
                    data-testid="channel-post-retry-confirm-checklist"
                  />
                  {t('channelPostsRetryConfirmChecklist')}
                </label>
              ) : null}
            </>
          )}
          cancelLabel={t('channelPostsRetryConfirmCancel')}
          confirmLabel={retrying ? t('channelPostsRetryConfirmPendingCta') : t('channelPostsRetryConfirmAction')}
          confirmDisabled={retrying || (failureAction?.kind === 'needs_check' && !retryChecklistConfirmed)}
          destructive={false}
          onConfirm={() => void handleRetry()}
        />
        {retryResult ? (
          <Alert
            variant={retryResult.type === 'error' ? 'destructive' : 'default'}
            role={retryResult.type === 'error' ? 'alert' : 'status'}
            data-testid="channel-post-retry-result"
          >
            <AlertDescription>
              {retryResult.type === 'success' ? t('channelPostsRetrySuccess') : retryResult.text}
            </AlertDescription>
            {retryResult.type === 'error' ? <RawDetailsToggle raw={retryResult.raw} label={t('errorRawDetailsToggle')} /> : null}
          </Alert>
        ) : null}
        {/* AC9 — 나가는 계정. */}
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">{t('channelPostsApprovalAccountLabel')}</span>
          <span data-testid="channel-post-account-label">{accountLabel ?? t('originAuthorUnknown')}</span>
        </div>
        {/* AC7 — 한도 잔량은 조회값이고 조회 실패도 상태다. 발행 버튼은 이 화면에 없으므로
            (PR2 몫) 여기서는 표시만 — 어떤 상태든 편집·상신을 막지 않는다. */}
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">{t('channelPostsApprovalLimitLabel')}</span>
          <span data-testid="channel-post-limit">
            {limit.status === 'loading'
              ? t('originAuthorUnknown')
              : limit.status === 'failed'
                ? t('channelPostsLimitCheckFailed')
                : `${limit.quotaTotal - limit.quotaUsage} / ${limit.quotaTotal}`}
          </span>
        </div>
        {/* AC8 — UTM은 화면이 붙이지 않고 붙은 것을 보인다. link_url이 없으면 그 줄
            자체를 그리지 않는다. */}
        {versions[versions.length - 1]?.tagged_link_preview ? (
          <div className="space-y-1">
            <span className="text-muted-foreground">{t('channelPostsApprovalLinkPreviewLabel')}</span>
            <p className="break-all text-foreground" data-testid="channel-post-tagged-link-preview">
              {versions[versions.length - 1]?.tagged_link_preview}
            </p>
          </div>
        ) : null}
        {/* story #3428(T5-M·§17-14) — 썸네일 + 자동 변환 배지. was_converted=false면
            원본=최종이라 배지 자체를 안 그린다(값은 서버가 낸 것만, 문구 조립만 화면
            몫 — 판정은 안 함). 이미지 없는 초안(thumbnail_url=null)은 이 블록 전체를
            건너뛴다. */}
        {draft.thumbnail_url ? (
          <div className="space-y-1">
            {/* eslint-disable-next-line @next/next/no-img-element -- story #3428: public-read GCS 오브젝트 URL(외부 도메인, next/image 대상 밖 — avatar_upload.py 소비부와 동형 관례). */}
            <img
              src={draft.thumbnail_url} alt={t('channelPostsImageAttachAlt')} className="h-32 w-32 rounded object-cover"
              data-testid="channel-post-approval-thumbnail"
            />
            {draft.image_was_converted ? (
              <p className="text-xs text-muted-foreground" data-testid="channel-post-image-converted-badge">
                {t('channelPostsImageConvertedBadge', {
                  originalWidth: draft.image_original_width ?? 0,
                  finalWidth: draft.image_final_width ?? 0,
                  originalBytes: typeof draft.image_original_bytes === 'number' ? formatFileSize(draft.image_original_bytes) : '',
                  finalBytes: typeof draft.image_final_bytes === 'number' ? formatFileSize(draft.image_final_bytes) : '',
                })}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* story #3402 PR2(T7/T9) — publication_status는 다섯 상태 밖의 신호라
          deriveChannelPostView가 별도 필드로 얹어 준다(WIP1과 동일 함수, 재사용). T7 —
          발행됨이면 재진입해도 permalink·published_at·external_id가 그대로 보인다(doc
          §4-2 "게시 ID로 동일성을 눈에 보이게"). T9 — 부분 성공(container_created)이면
          "이어서 발행"이 기본 행동임을 미리 안다(발행 버튼 자체의 배선은 이 조각 스코프
          밖 — 다음 조각). PR1 rebase 반영(2026-09-04) — 위 승인 카드가 이미 계산해 둔
          `view`를 그대로 재사용한다(같은 함수를 두 번 부르지 않는다 — rebase 전엔 이
          블록이 자체 IIFE로 따로 계산했으나, PR1의 hasGateContract 가드가 상위로
          올라오며 중복이 됐다). */}
      {(() => {
        if (view.status === 'published' && draft.permalink) {
          return (
            <div className="space-y-2 rounded-md border border-border p-4 text-sm" data-testid="channel-post-published-info">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{t('publishedInfoUrlLabel')}</span>
                <a href={draft.permalink} target="_blank" rel="noreferrer" className="underline">{draft.permalink}</a>
              </div>
              {draft.published_at ? (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">{t('publishedInfoAtLabel')}</span>
                  <span>{formatScheduledAt(draft.published_at, displayTimezone).display}</span>
                </div>
              ) : null}
              {draft.external_id ? (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground" data-testid="channel-post-external-id-label">{t('channelPostsExternalIdLabel')}</span>
                  <span data-testid="channel-post-external-id">{draft.external_id}</span>
                </div>
              ) : null}
              {/* story #3499(Phase2·FE) — publication_id 있을 때만(BE #3844 조각4 의존). */}
              {draft.publication_id ? (
                <InsightSnapshotBlock snapshots={insightSnapshots} orgTimezone={displayTimezone} locale={locale} />
              ) : null}
              {/* story #3517(Phase2·FE, 그라운딩 ① 자리 그대로 — InsightSnapshotBlock 곁,
                  같은 draft.publication_id 조건) — 댓글 섹션. */}
              {draft.publication_id ? (
                <CommentsSection
                  face={commentsFace}
                  displayTimezone={displayTimezone}
                  onConvertToTask={setConvertToTaskComment}
                  onReply={() => {
                    // story #3517 — 답변 초안→상신→승인 카드 흐름은 조각②(답변/작업전환
                    // 엔드포인트) 대기 중(그라운딩 보고 済). 배선 자체는 다음 조각.
                  }}
                />
              ) : null}
            </div>
          );
        }
        if (view.unpublished) {
          // story #3426(doc §17-10②) — 회수돼도 승인(gate) 자체는 안 풀린다 — 칩은
          // 「승인됨」 그대로이고 이 오버레이가 "회수됨"을 얹는다(partialSuccess/
          // publicationFailed와 같은 자리). story #3428(PO 확定, 2026-09-04 12:19Z) —
          // unpublished는 published 이후에만 성립하므로 processing_kind(발행 진행 중
          // 신호)와 동시 불가 — 그래도 겹치면 데이터 결함으로 보고 unpublished를
          // 우선한다(이 분기가 processing_kind 분기보다 먼저 온다).
          return (
            <Alert role="status" data-testid="channel-post-unpublished-notice">
              <AlertDescription>{t('channelPostsUnpublishedNotice')}</AlertDescription>
            </Alert>
          );
        }
        // story #3428(§17-15, PO 확定 2026-09-04 12:19Z) — processing_kind='awaiting_
        // container'는 command_status=pending ∧ publication_status=container_created를
        // 서버가 이미 파생한 값(같은 근본 상태를 partialSuccess도 본다) — 명령이 살아
        // 있으면(=아직 자동 재시도/폴링 중) 실패가 아니므로 이 알림 하나만 보이고
        // partialSuccess는 그리지 않는다(아래 분기보다 먼저 체크). 명령이 blocked/
        // dead_letter/needs_check로 전이되면 서버가 processing_kind를 null로 되돌리므로
        // (BE 620beefc _to_draft_list_item) 이 분기는 자연히 사라지고 실패 알림이 대신
        // 선다 — 화면이 두 신호를 조합판정하지 않는다.
        if (draft.processing_kind === 'awaiting_container') {
          return (
            <Alert role="status" data-testid="channel-post-awaiting-container-notice">
              <AlertDescription>{t('channelPostsAwaitingContainerNotice')}</AlertDescription>
            </Alert>
          );
        }
        if (view.publicationFailed) {
          return (
            <Alert variant="destructive" role="alert" data-testid="channel-post-publication-failed-notice">
              <AlertDescription>{t('channelPostsPublicationFailedNotice')}</AlertDescription>
            </Alert>
          );
        }
        if (view.partialSuccess) {
          return (
            <Alert role="status" data-testid="channel-post-partial-success-notice">
              <AlertDescription>{t('channelPostsPartialSuccessNotice')}</AlertDescription>
            </Alert>
          );
        }
        return null;
      })()}

      {/* story #3402 PR2 ②-a/②-b — 발행 버튼. AC5 — 비활성 사유 문구는 버튼 밖에 둔다
          (라벨 안에 넣으면 disabled:opacity-50에 워시된다, Phase 0 실측 그대로 재사용).
          story #3426 — 예약 취소·회수 버튼은 BE #3419(PR#3774) 착지로 복원됨(cancel-
          scheduled·unpublish 엔드포인트 신설·can_unpublish 판정값) — 아래 두 버튼. */}
      <div className="space-y-2">
        <div className="flex gap-2">
          <Button
            onClick={() => void handlePublish()}
            disabled={!canPublish || publishing || blockedByCommandInFlight}
            data-testid="channel-post-publish-button"
          >
            {/* story #3402 PR2 ②-c(T9·doc §4-1/§17-4) — 부분 성공(container_created)이면
                기본 행동이 "다시"가 아니라 "이어서 발행"이다(처음부터 하면 컨테이너가
                하나 더 생겨 같은 글이 두 번 나갈 수 있다, §4-1). partialSuccess 분기가
                site-posts의 isRepublish(재승인 뒤 재발행) 분기보다 먼저다 — 둘 다 참일
                일은 없지만(부분성공은 채널 고유 신호, isRepublish는 사이트 공유 파생)
                우선순위를 명시해 둔다. */}
            {publishing ? t('publishPendingCta') : view.partialSuccess ? t('channelPostsPublishContinueCta') : view.isRepublish ? t('publishRepublishCta') : t('publishCta')}
          </Button>
          {/* story #3426 ①-b/①-c — 예약 취소·회수 버튼. PR2에서 렌더 보류했던 「발행
              취소」 버튼을 BE #3419 착지로 복원한다. 둘 다 되돌리기 번거로운/불가능한
              전환이라 ConfirmDialog를 거친다(story #2416 — native confirm() 금지). */}
          {showCancelScheduled ? (
            <Button
              variant="outline" disabled={!canCancelScheduled || cancellingScheduled}
              onClick={() => setCancelScheduledConfirmOpen(true)} data-testid="channel-post-cancel-scheduled-button"
            >
              {t('channelPostsCancelScheduledCta')}
            </Button>
          ) : null}
          {showUnpublish && unpublishGate?.blockedReason !== 'unsupported' ? (
            <Button
              variant="outline" disabled={!canUnpublishNow || unpublishing}
              onClick={() => setUnpublishConfirmOpen(true)} data-testid="channel-post-unpublish-button"
            >
              {t('channelPostsUnpublishCta')}
            </Button>
          ) : null}
        </div>
        {!canPublish ? (
          <p className="text-xs text-muted-foreground" data-testid="channel-post-publish-disabled-reason">
            {view.blockedReason === 'SEAL_MISSING' ? t('publishDisabledReasonSealMissing') : t('publishDisabledReason')}
          </p>
        ) : null}
        {/* B4(페드루 PO) — canPublish는 참인데 command_status가 pending/blocked라 막힌
            경우는 위와 다른 사유(게이트 문제가 아니라 이미 진행 중이거나 연결이 막힘).
            story #3458 페드루 PO 실물 확認(2026-09-04 17:22Z) — blocked는 canPublish에
            매달면 안 된다: 발행 済 글의 unpublish 명령이 만료 토큰으로 blocked인 조합은
            publishable=false(canPublish=false)라 이 사유줄이 안 뜨는데, 그 상태에선
            FailureActionBadge(짧은 명사구로 줄인 지금)에도 링크가 없어 "연결 화면"이
            화면 어디에도 안 남는다 — 불변식 "blocked 배지가 뜨면 링크 사유줄도 뜬다"를
            지키려면 blocked는 canPublish와 무관하게 독립 렌더해야 한다. pending은 링크
            대상이 없어 그대로 canPublish 안에 둔다. */}
        {draft.command_status === 'blocked' || (canPublish && blockedByCommandInFlight) ? (
          <p className="text-xs text-muted-foreground" data-testid="channel-post-command-inflight-reason">
            {t.rich(commandInFlightReasonKey, {
              link: (chunks) => <Link href="/organization/channels" className="underline">{chunks}</Link>,
            })}
          </p>
        ) : null}
        {showCancelScheduled && !canCancelScheduled ? (
          <p className="text-xs text-muted-foreground" data-testid="channel-post-cancel-scheduled-disabled-reason">
            {t('channelPostsCancelUnpublishOwnerOrAdminOnly')}
          </p>
        ) : null}
        {/* doc §17-11 정본 — unsupported는 대상 아님(문구 없음, 버튼도 없음 — 없는 자리를
            안 그린다). scope_insufficient만 role별 두 문장(owner: 재연결하면 풀림 /
            member: owner에게 요청). role 게이팅(owner/admin 아님)이 blocked_reason보다
            먼저 걸리면 그 사유가 우선(§17-11은 "권한은 있는데 스코프가 없다"는 경우 전용). */}
        {/* 유나 프로브 실측(2026-09-04 17:28Z) — 네 가지 사유가 같은 testid를 덮어써
            프로브가 문구 텍스트로 갈래를 구별해야 했다. data-unpublish-reason 안정
            키를 각 갈래에 하나씩(시각 변화 0) — 프로브·QA가 이 값으로 읽는다. */}
        {showUnpublish && !canUnpublish ? (
          <p className="text-xs text-muted-foreground" data-testid="channel-post-unpublish-disabled-reason" data-unpublish-reason="role">
            {t('channelPostsCancelUnpublishOwnerOrAdminOnly')}
          </p>
        ) : showUnpublish && canUnpublish && unpublishGate?.blockedReason === 'scope_insufficient' ? (
          <p className="text-xs text-muted-foreground" data-testid="channel-post-unpublish-disabled-reason" data-unpublish-reason="scope_insufficient">
            {/* owner만 「연결 화면」 링크(재연결이 실제로 갈 곳) — nonOwner 문구는
                owner에게 요청하라는 안내라 이 화면 안에 갈 곳이 없다(링크 없음 그대로). */}
            {role === 'owner'
              ? t.rich('channelPostsUnpublishScopeInsufficientOwner', {
                link: (chunks) => <Link href="/organization/channels" className="underline">{chunks}</Link>,
              })
              : t('channelPostsUnpublishScopeInsufficientNonOwner')}
          </p>
        ) : showUnpublish && canUnpublish && unpublishGate?.canUnpublish === true && unpublishGate.connectionStatus !== 'active' ? (
          // story #3458 — can_unpublish(어댑터 성질)는 참인데 연결 상태(토큰 등)가
          // active가 아니라 막힌 경우. 「연결 화면」에 인라인 링크(사람이 할 일이 그
          // 하나뿐인데 전역 내비를 뒤지게 하지 않는다).
          <p className="text-xs text-muted-foreground" data-testid="channel-post-unpublish-disabled-reason" data-unpublish-reason="connection_not_active">
            {t.rich('channelPostsUnpublishConnectionNotActive', {
              link: (chunks) => <Link href="/organization/channels" className="underline">{chunks}</Link>,
            })}
          </p>
        ) : showUnpublish && canUnpublish && unpublishGate === undefined ? (
          // 페드루 PO nit(2026-09-04 09:07Z) — 연결 조회 자체가 실패/아직 안 끝났으면
          // "모른다"인데 버튼만 비활성이고 이유가 없었다(AC1 "사유는 버튼 밖" 규율 위반).
          <p className="text-xs text-muted-foreground" data-testid="channel-post-unpublish-disabled-reason" data-unpublish-reason="unknown">
            {t('channelPostsUnpublishGateUnknown')}
          </p>
        ) : null}
        {publishResult ? (
          <Alert variant={publishResult.type === 'error' ? 'destructive' : 'default'} role={publishResult.type === 'error' ? 'alert' : 'status'} data-testid="channel-post-publish-result">
            <AlertDescription>
              {publishResult.type === 'success'
                ? t('publishSuccess', { time: draft.published_at ? formatScheduledAt(draft.published_at, displayTimezone).display : '' })
                : publishResult.type === 'scheduled'
                  ? t('channelPostsPublishScheduled', { time: publishResult.scheduledAt ? formatScheduledAt(publishResult.scheduledAt, displayTimezone).display : t('originAuthorUnknown') })
                  : (
                    // story #3402 AC11(doc §5-1) — "왜 막혔나"(text)와 "밖으로 나갔나"
                    // (externalImpact)는 서로 다른 사실이라 별도 텍스트 노드로 따로 둔다
                    // (카디르 QA 계획 ④ — 겹치는 단어로 한 문장에 뭉쳐 정규식 하나로 통과
                    // 하는 함정 방지, 개별 assert 가능하게). 카디르 QA 실결함 지적
                    // (2026-09-04) — 이 블록의 부모가 AlertDescription(=<p>)이라 여기서
                    // <p>를 또 쓰면 p 안에 p가 중첩돼 HTML 무효+Next hydration 에러가
                    // 실제로 났다(jsdom 테스트는 관대해서 안 잡음). <span className="block">
                    // 로 교체 — 줄바꿈은 유지하되 유효한 중첩.
                    <>
                      <span className="block" data-testid="channel-post-publish-error-reason">{publishResult.text}</span>
                      {publishResult.externalImpact ? (
                        <span className="block" data-testid="channel-post-publish-external-impact">
                          {publishResult.externalImpact === 'reached_provider'
                            ? t('channelPostsExternalImpactReachedProvider')
                            : publishResult.externalImpact === 'unknown'
                              ? t('channelPostsExternalImpactUnknown')
                              : t('channelPostsExternalImpactNotSent')}
                        </span>
                      ) : null}
                    </>
                  )}
            </AlertDescription>
            {publishResult.type === 'error' ? <RawDetailsToggle raw={publishResult.raw} label={t('errorRawDetailsToggle')} /> : null}
          </Alert>
        ) : null}

        <ConfirmDialog
          open={cancelScheduledConfirmOpen}
          onOpenChange={setCancelScheduledConfirmOpen}
          title={t('channelPostsCancelScheduledConfirmTitle')}
          description={(
            // 카디르 QA①·유나 §8 — 「무엇이 멈추나」·「되돌릴 수 있나」는 서로 다른 사실이라
            // 한 노드에 뭉치지 않는다(AC11 두 문장과 같은 규율). DialogDescription이 <p>라
            // 안쪽도 <span className="block">로 — p 중첩 금지(story #3402 QA 실결함과 동형).
            <>
              <span className="block" data-testid="channel-post-cancel-scheduled-confirm-what">{t('channelPostsCancelScheduledConfirmWhat')}</span>
              <span className="block" data-testid="channel-post-cancel-scheduled-confirm-reversible">{t('channelPostsCancelScheduledConfirmReversible')}</span>
            </>
          )}
          cancelLabel={t('channelPostsCancelScheduledConfirmCancel')}
          confirmLabel={t('channelPostsCancelScheduledConfirmAction')}
          onConfirm={() => void handleCancelScheduled()}
        />
        {cancelScheduledResult ? (
          <Alert
            variant={cancelScheduledResult.type === 'error' ? 'destructive' : 'default'}
            role={cancelScheduledResult.type === 'error' ? 'alert' : 'status'}
            data-testid="channel-post-cancel-scheduled-result"
          >
            <AlertDescription>
              {cancelScheduledResult.type === 'success' ? t('channelPostsCancelScheduledSuccess') : cancelScheduledResult.text}
            </AlertDescription>
            {cancelScheduledResult.type === 'error' ? <RawDetailsToggle raw={cancelScheduledResult.raw} label={t('errorRawDetailsToggle')} /> : null}
          </Alert>
        ) : null}
        {/* 페드루 PO 블로커(2026-09-04 09:02Z) — 성공 배너만으로는 §17-10 "취소됨"
            상태가 상세에 안 남는다. 회수됨 Alert와 같은 자리에 오버레이로 얹는다. */}
        {draft.command_status === 'cancelled' ? (
          <Alert role="status" data-testid="channel-post-cancelled-notice">
            <AlertDescription>{t('channelPostsCancelledNotice')}</AlertDescription>
          </Alert>
        ) : null}

        <ConfirmDialog
          open={unpublishConfirmOpen}
          onOpenChange={setUnpublishConfirmOpen}
          title={t('channelPostsUnpublishConfirmTitle')}
          description={(
            <>
              <span className="block" data-testid="channel-post-unpublish-confirm-what">{t('channelPostsUnpublishConfirmWhat')}</span>
              <span className="block" data-testid="channel-post-unpublish-confirm-reversible">{t('channelPostsUnpublishConfirmReversible')}</span>
            </>
          )}
          cancelLabel={t('channelPostsUnpublishConfirmCancel')}
          confirmLabel={t('channelPostsUnpublishConfirmAction')}
          onConfirm={() => void handleUnpublish()}
        />
        {unpublishResult ? (
          <Alert
            variant={unpublishResult.type === 'error' ? 'destructive' : 'default'}
            role={unpublishResult.type === 'error' ? 'alert' : 'status'}
            data-testid="channel-post-unpublish-result"
          >
            <AlertDescription>
              {unpublishResult.type === 'success' ? t('channelPostsUnpublishSuccess') : unpublishResult.text}
            </AlertDescription>
            {unpublishResult.type === 'error' ? <RawDetailsToggle raw={unpublishResult.raw} label={t('errorRawDetailsToggle')} /> : null}
          </Alert>
        ) : null}
      </div>

      <div className="space-y-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          className="w-full rounded-md border border-border p-3 text-sm"
          data-testid="channel-post-text-field"
        />
        {/* AC6 — 500은 화면에 박지 않는다: maxTextLength가 실제 어댑터 선언값. */}
        <div className="flex items-center justify-between text-xs">
          <span
            className={isOverLimit ? 'rounded-full bg-destructive-tint px-1.5 py-0.5 text-foreground' : 'text-muted-foreground'}
            data-testid="channel-post-char-count"
          >
            {typeof maxTextLength === 'number'
              ? `${textLength} / ${maxTextLength}`
              : maxTextLength === null
                ? `${textLength} · ${t('channelPostsCharLimitUnknown')}`
                : `${textLength}`}
          </span>
        </div>
        {/* story #3472 2부(유나 §16-7) — "그 필드 아래" 그 필드 것만 목록. 경고색
            없음(아직 아무것도 실패하지 않았다·사람이 고치는 중). FailureActionBadge
            동형 아님(하우스 폼 검증 관례=필드 아래 한 줄, channel-post-text-field-
            empty-reason과 같은 톤). story #3483 — 공용 컴포넌트로(site-posts 재사용). */}
        <ContentRuleViolationList
          violations={violations.filter((v) => v.field === 'text')}
          testId="channel-post-rule-violation-text"
          t={t}
        />
        <input
          value={linkUrl}
          onChange={(e) => setLinkUrl(e.target.value)}
          placeholder="https://…"
          className="w-full rounded-md border border-border p-2 text-sm"
          data-testid="channel-post-link-field"
        />
        <ContentRuleViolationList
          violations={violations.filter((v) => v.field === 'link_url')}
          testId="channel-post-rule-violation-link"
          t={t}
        />
      </div>

      {/* story #3428(T3-M·§17-16) — image_max_count<=0(미지원 채널, 또는 아직 모른다)
          이면 첨부 칸 자체를 그리지 않는다. 규격 태그는 어댑터 선언값 그대로(하드코딩
          금지 축) — 값을 지어내지 않는다. */}
      {imageSpec && imageSpec.maxCount > 0 ? (
        <div className="space-y-2 rounded-md border border-border p-3 text-sm" data-testid="channel-post-image-attach">
          <div className="flex items-center justify-between">
            {/* B3(페드루 PO·유나 지적, 2026-09-04) — 어댑터가 image_max_count>1을 선언해도
                이 첨부 칸은 파일 하나만 받는다(input에 multiple 없음·onChange가 files[0]만
                읽음·confirm이 draft 이미지 필드를 한 장으로 덮어씀 — 진짜 다중첨부가
                아니다). "{count}장까지"라고 적으면 화면이 실제로 안 하는 일을 약속하는
                거짓말이 된다 — 개수를 아예 안 적는다. */}
            <span className="text-muted-foreground">{t('channelPostsImageAttachLabel')}</span>
          </div>
          <p className="text-xs text-muted-foreground" data-testid="channel-post-image-spec-tag">
            {t('channelPostsImageSpecTag', {
              formats: imageSpec.formats.map((f) => f.replace('image/', '').toUpperCase()).join(', '),
              maxBytes: formatFileSize(imageSpec.maxBytes),
              aspectMax: imageSpec.aspectMax,
              widthMin: imageSpec.widthMin,
              widthMax: imageSpec.widthMax,
              // N(페드루 PO, 2026-09-04 13:27Z) — 연결 응답에서 이미 읽던 image_color_space가
              // imageSpec까지만 오고 화면엔 한 번도 안 실렸던 갭.
              colorSpace: imageSpec.colorSpace,
            })}
          </p>
          {draft.thumbnail_url ? (
            <div className="space-y-1">
              {/* eslint-disable-next-line @next/next/no-img-element -- story #3428: public-read GCS 오브젝트 URL(외부 도메인, next/image 대상 밖 — avatar_upload.py 소비부와 동형 관례). */}
              <img
                src={draft.thumbnail_url} alt={t('channelPostsImageAttachAlt')}
                className="h-24 w-24 rounded object-cover" data-testid="channel-post-image-preview"
              />
              {/* 배지 첨부 칸(페드루 PO, 2026-09-04 13:41Z) — 이 미리보기도 파생본(변환
                  결과)을 그리므로 image_was_converted일 때 승인 카드(§13-3)와 같은
                  배지·같은 문구를 함께 보인다(새 문구 없음·false면 안 그림). 승인 카드
                  =확定 결과 보여주는 자리, 여기=작성자가 지금 첨부가 어떻게 변환됐는지
                  확인하는 자리 — 둘 다 image_final_object_path 기준이라 같은 값이다.
                  <img> 2벌은 의도적으로 유지(§13-3 그대로). */}
              {draft.image_was_converted ? (
                <p className="text-xs text-muted-foreground" data-testid="channel-post-image-attach-converted-badge">
                  {t('channelPostsImageConvertedBadge', {
                    originalWidth: draft.image_original_width ?? 0,
                    finalWidth: draft.image_final_width ?? 0,
                    originalBytes: typeof draft.image_original_bytes === 'number' ? formatFileSize(draft.image_original_bytes) : '',
                    finalBytes: typeof draft.image_final_bytes === 'number' ? formatFileSize(draft.image_final_bytes) : '',
                  })}
                </p>
              ) : null}
            </div>
          ) : null}
          {/* ②(유나 지적, 2026-09-04) — <input type=file>는 접근 가능한 이름이 0이고
              그리는 브라우저 기본 컨트롤 라벨("파일 선택" 등)이 브라우저 로케일을 따라
              앱 로케일과 어긋난다. 실제로 화면에 그리는 것은 라벨이 붙은 Button — input
              자체는 hidden으로 접근성 트리 밖에 두고 ref로만 클릭을 위임한다. */}
          <input
            ref={imageFileInputRef}
            type="file"
            accept={imageSpec.formats.join(',')}
            hidden
            data-testid="channel-post-image-file-input"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void handleImageFileSelected(file);
            }}
          />
          <Button
            type="button" variant="outline" size="sm"
            disabled={imageUploadInProgress}
            onClick={() => imageFileInputRef.current?.click()}
            data-testid="channel-post-image-attach-trigger"
          >
            {t('channelPostsImageAttachTriggerCta')}
          </Button>
          {imageUploadInProgress ? (
            <p className="text-xs text-muted-foreground" data-testid="channel-post-image-upload-progress">
              {imageUploadStatus.phase === 'requesting_url'
                ? t('channelPostsImageUploadRequestingUrl')
                : imageUploadStatus.phase === 'uploading'
                  ? t('channelPostsImageUploading')
                  : t('channelPostsImageConfirming')}
            </p>
          ) : null}
          {imageUploadStatus.phase === 'error' ? (
            <Alert variant="destructive" role="alert" data-testid="channel-post-image-upload-error">
              <AlertDescription>{imageUploadStatus.text}</AlertDescription>
              <RawDetailsToggle raw={imageUploadStatus.raw} label={t('errorRawDetailsToggle')} />
            </Alert>
          ) : null}
        </div>
      ) : null}

      {saveMessage ? (
        <Alert variant={saveMessage.type === 'error' ? 'destructive' : 'default'} role="status">
          <AlertDescription>{saveMessage.text}</AlertDescription>
          {saveMessage.type === 'error' ? <RawDetailsToggle raw={saveMessage.raw} label={t('errorRawDetailsToggle')} /> : null}
        </Alert>
      ) : null}

      {/* doc a0da40c9 §19-7(디자인 유나 確定 2026-09-05) — 상신 버튼 «위» 자체 줄(옆
          아님 — 선택 입력을 버튼 옆에 두면 필수처럼 보이고, 버튼 라벨이 좁은 화면에서
          깨진다). 별도 다이얼로그가 아닌 plain input(그라운딩 확認 — 이 코드베이스에
          MoneyInput류 0건, ScheduleAtDialog는 datetime 전용). 통화는 조직 정책값을
          라벨로만 보이고 피커는 없다(§19-7). 입력/변환은 큰단위(major) — §19-1. */}
      {/* PO REQUIRED②(2026-09-05) — 입력은 generationBudgetUsable일 때만(통화를 모르는
          채 숫자를 입력받지 않는다). GenerationBudgetIndicator는 항상 그린다 — 그
          컴포넌트가 loading/failed/정책없음/정상을 이미 스스로 갈라 보여준다. */}
      <div className="flex items-center gap-2">
        {generationBudgetUsable ? (
          <>
            <label htmlFor="channel-post-estimated-cost" className="text-xs text-muted-foreground">
              {t('generationBudgetEstimatedCostLabel')}
            </label>
            <input
              id="channel-post-estimated-cost"
              type="number"
              min={0}
              step={1}
              value={estimatedCostInput}
              onChange={(e) => setEstimatedCostInput(e.target.value)}
              className="w-28 rounded-md border border-border bg-background px-2 py-1 text-sm"
              data-testid="channel-post-estimated-cost-input"
            />
            <span className="text-xs text-muted-foreground">{generationBudgetCurrency}</span>
          </>
        ) : null}
        <GenerationBudgetIndicator state={genBudget} variant="compact" />
      </div>
      <div className="flex gap-2">
        <Button onClick={handleSave} disabled={saving || imageUploadInProgress} data-testid="channel-post-save-button">
          {saving ? t('editSavingCta') : t('editSaveCta')}
        </Button>
        <Button
          onClick={() => void handleSubmitForApproval()}
          disabled={submitting || isOverLimit || hasBlockingViolations || imageUploadInProgress}
          data-testid="channel-post-submit-button"
        >
          {submitting ? t('submitPendingCta') : t('submitCta')}
        </Button>
        {/* story #3422 ②-d — 예약 상신(doc §11 T8 "상신 시 scheduled_at 입력"). 즉시
            상신과 같은 게이팅(isOverLimit)을 공유 — 한도 초과면 예약도 막는다. B4(페드루
            PO, 2026-09-04 13:26Z) — command_status가 pending/blocked면 새 예약도 막는다
            (즉시 상신은 이 게이팅 밖 — PO 지시가 발행·예약 상신 둘로 명시). */}
        <Button
          variant="outline"
          onClick={() => setScheduleDialogOpen(true)}
          disabled={submitting || isOverLimit || hasBlockingViolations || blockedByCommandInFlight || imageUploadInProgress}
          data-testid="channel-post-schedule-submit-button"
        >
          {t('channelPostsScheduleSubmitCta')}
        </Button>
      </div>
      <ScheduleAtDialog
        open={scheduleDialogOpen}
        onOpenChange={(next) => { setScheduleDialogOpen(next); if (!next) setScheduleServerError(null); }}
        onSubmit={(iso) => void handleSubmitForApproval(iso)}
        submitting={submitting}
        serverError={scheduleServerError}
      />
      {/* story #3517(Phase2·FE) — 조각②(작업전환 엔드포인트)가 아직 없어 실제 POST는
          미배선(§22-④ prefill·다이얼로그 자체는 조각①만으로 완결). 게시물 제목은
          이 화면엔 별도 title 필드가 없다(text 자체가 본문) — 원문(source_title)이
          있으면 그걸, 없으면(단독 채널 초안) 본문 앞부분으로 대체(지어내지 않되
          다이얼로그 제목 칸을 비워 두지 않는다, §21-5 관례). */}
      {convertToTaskComment ? (
        <CommentConvertToTaskDialog
          postTitle={draft.source_title ?? (versions[versions.length - 1]?.text.slice(0, 40) ?? '')}
          comment={convertToTaskComment}
          onClose={() => setConvertToTaskComment(null)}
          onSubmit={() => Promise.resolve({ ok: false, errorMessage: t('commentsConvertPendingBackend') })}
        />
      ) : null}
      {/* AC6 — 비활성 이유는 버튼 밖에 둔다(라벨 안에 넣으면 disabled:opacity-50에
          워시된다, Phase 0 실측). */}
      {isOverLimit ? (
        <p className="text-xs text-muted-foreground" data-testid="channel-post-over-limit-reason">
          {t('channelPostsOverLimitReason')}
        </p>
      ) : null}
      {/* story #3472 2부(§16-7) — "그래서 못 한다"는 버튼 밖·비활성(§17-13과 같은 규율).
          "필드 아래"(무엇이 걸렸나)와 자리가 다르다 — 여기는 개수만 세고 가리킨다.
          story #3483 — 공용 컴포넌트로. */}
      {!isOverLimit && hasBlockingViolations ? (
        <ContentRuleSubmitBlockedReason count={violations.length} testId="channel-post-rule-violation-blocked-reason" t={t} />
      ) : null}
      {/* B2(페드루 PO, 2026-09-04 13:27Z) — 이미지 업로드 진행 중엔 저장/상신이 왜
          막혔는지 버튼 밖에 밝힌다(isOverLimit과 동시에 뜰 수 있어 둘 다 없을 때만). */}
      {!isOverLimit && !hasBlockingViolations && imageUploadInProgress ? (
        <p className="text-xs text-muted-foreground" data-testid="channel-post-image-upload-in-progress-reason">
          {t('channelPostsImageUploadInProgressReason')}
        </p>
      ) : null}
      {!isOverLimit && !hasBlockingViolations && blockedByCommandInFlight ? (
        <p className="text-xs text-muted-foreground" data-testid="channel-post-schedule-submit-command-inflight-reason">
          {t.rich(commandInFlightReasonKey, {
            link: (chunks) => <Link href="/organization/channels" className="underline">{chunks}</Link>,
          })}
        </p>
      ) : null}

      {genBudgetExceeded ? (
        <GenerationBudgetExceededBanner
          limitMinor={genBudgetExceeded.limitMinor}
          spentMinor={genBudgetExceeded.spentMinor}
          estimatedCostMinor={genBudgetExceeded.estimatedCostMinor}
          remainingMinor={genBudgetExceeded.remainingMinor}
          currency={genBudgetExceeded.currency}
        />
      ) : null}

      {submitResult ? (
        submitResult.type === 'success' ? (
          <Alert role="status">
            <AlertDescription>
              {t('submitSuccess')}{' '}
              <Link href={`/gates/${submitResult.gateId}`} className="underline">{t('submitGateLink')}</Link>
            </AlertDescription>
          </Alert>
        ) : (
          <Alert variant="destructive" role="alert">
            <AlertDescription>
              {submitResult.text}
              {submitResult.heldByDraftId ? (
                <>
                  {' '}
                  <Link href={`/content/channel-posts/${submitResult.heldByDraftId}`} className="underline">
                    {t('errorGateAlreadyHeldLink')}
                  </Link>
                </>
              ) : null}
            </AlertDescription>
            <RawDetailsToggle raw={submitResult.raw} label={t('errorRawDetailsToggle')} />
          </Alert>
        )
      ) : null}
    </div>
  );
}
