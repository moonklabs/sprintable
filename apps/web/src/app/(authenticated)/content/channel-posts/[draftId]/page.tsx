'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { fetchWithAuth } from '@/lib/db/client';
import { channelTextLength } from '@/components/content/channel-text-length';
import { parseSitePostApiError, type SitePostApiErrorInfo } from '@/components/content/api-error';
import { deriveChannelPostView, type ChannelPublicationStatus } from '@/components/content/channel-post-status';
import { describeExternalImpact } from '@/components/content/external-impact';
import { contentPostStatusLabelKey } from '@/components/content/post-status';

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
  processing_kind?: string | null;
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

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

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
        maxBytes: typeof info.imageMaxBytes === 'number' ? formatMegabytes(info.imageMaxBytes) : '',
        sizeBytes: typeof info.imageSizeBytes === 'number' ? formatMegabytes(info.imageSizeBytes) : '',
      });
    case 'image_aspect_ratio_exceeded':
      return t('channelPostsImageAspectRatioExceeded', {
        maxAspectRatio: info.imageMaxAspectRatio?.toFixed(1) ?? '',
        aspectRatio: info.imageAspectRatio?.toFixed(2) ?? '',
      });
    case 'image_conversion_failed':
      return t('channelPostsImageConversionFailed', {
        maxBytes: typeof info.imageMaxBytes === 'number' ? formatMegabytes(info.imageMaxBytes) : '',
        finalBytes: typeof info.imageFinalBytes === 'number' ? formatMegabytes(info.imageFinalBytes) : '',
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

  const [draft, setDraft] = useState<ChannelPostDraftDetail | null>(null);
  const [versions, setVersions] = useState<ChannelPostVersion[]>([]);
  const [maxTextLength, setMaxTextLength] = useState<number | null | undefined>(undefined);
  // story #3402 ④(AC9) — account_label(없으면 account_id)로 나가는 계정을 승인 카드에
  // 적는다. undefined="아직 모른다"(연결 조회 전/실패) — accountId 자체가 없다는 뜻은
  // 아니다(그 값은 findConnection이 못 찾은 경우에만 undefined로 남는다).
  const [accountLabel, setAccountLabel] = useState<string | undefined>(undefined);
  // story #3426 — undefined="연결 조회 전/실패, 아직 모른다"(§3-2와 같은 축) · 조회 성공하면
  // 연결의 can_unpublish/unpublish_blocked_reason 그대로.
  const [unpublishGate, setUnpublishGate] = useState<
    { canUnpublish: boolean; blockedReason: 'unsupported' | 'scope_insufficient' | null } | undefined
  >(undefined);
  const [limit, setLimit] = useState<PublishingLimitState>({ status: 'loading' });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  // story #3428(T3-M·§17-16) — 어댑터가 선언한 이미지 규격(연결 응답에서 읽음).
  // undefined="아직 모른다"(연결 조회 전/실패) — maxCount<=0과 동형으로 첨부 칸을
  // 그리지 않는다(둘 다 "모른다"와 "미지원"을 같은 쪽으로 fail-closed).
  const [imageSpec, setImageSpec] = useState<
    { maxCount: number; formats: string[]; maxBytes: number; aspectMax: number; widthMin: number; widthMax: number } | undefined
  >(undefined);
  const [imageUploadStatus, setImageUploadStatus] = useState<
    | { phase: 'idle' }
    | { phase: 'requesting_url' }
    | { phase: 'uploading' }
    | { phase: 'confirming' }
    | { phase: 'error'; text: string; raw?: string }
  >({ phase: 'idle' });

  const [text, setText] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{ type: 'success' | 'error'; text: string; raw?: string } | null>(null);

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
  const [cancelScheduledResult, setCancelScheduledResult] = useState<{ type: 'success' } | { type: 'error'; text: string } | null>(null);

  const [unpublishConfirmOpen, setUnpublishConfirmOpen] = useState(false);
  const [unpublishing, setUnpublishing] = useState(false);
  const [unpublishResult, setUnpublishResult] = useState<{ type: 'success' } | { type: 'error'; text: string } | null>(null);

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
            if (conn) setUnpublishGate({ canUnpublish: conn.can_unpublish, blockedReason: conn.unpublish_blocked_reason });
            // story #3428(T3-M) — 이미지 규격(어댑터 성질) 그대로 읽는다(하드코딩 금지 축).
            if (conn) {
              setImageSpec({
                maxCount: conn.image_max_count, formats: conn.image_formats, maxBytes: conn.image_max_bytes,
                aspectMax: conn.image_aspect_max, widthMin: conn.image_width_min, widthMax: conn.image_width_max,
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

  const textLength = channelTextLength(text);
  // AC6 — 한도 미선언(null)이면 초과 판정 자체를 안 한다(지어내지 않는다, 상신은 막지 않음).
  const isOverLimit = typeof maxTextLength === 'number' && textLength > maxTextLength;

  const handleSave = async () => {
    if (!orgId || !draft) return;
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
        const versionsRes = await fetchWithAuth(`/api/organizations/${orgId}/channel-posts/drafts/${draftId}/versions`);
        if (versionsRes.ok) {
          const json = (await versionsRes.json().catch(() => null)) as { data?: ChannelPostVersion[] } | null;
          if (json?.data) setVersions(json.data);
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
  const handleSubmitForApproval = async () => {
    if (!orgId || !draft || isOverLimit) return;
    const latest = versions[versions.length - 1];
    if (!latest) return;
    setSubmitting(true);
    setSubmitResult(null);
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgId}/channel-posts/drafts/${draftId}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version_id: latest.version_id }),
      });
      if (res.ok) {
        const json = (await res.json().catch(() => null)) as { data?: { gate_id?: string } } | null;
        const gateId = json?.data?.gate_id;
        if (gateId) {
          setSubmitResult({ type: 'success', gateId });
        } else {
          setSubmitResult({ type: 'error', text: t('submitFailed'), raw: JSON.stringify(json) });
        }
      } else {
        const body = await res.json().catch(() => null);
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
          const channelLabel = info.heldByChannel === 'threads' ? t('channelThreads') : (info.heldByChannel ?? t('channelThreads'));
          let holdingLabel = `${channelLabel} 초안 ····${holdingDraftId.slice(0, 4)}`;
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
      setDraft((prev) => (prev ? {
        ...prev,
        current_version: image.version,
        thumbnail_url: image.image_url,
        image_original_width: image.original_width,
        image_original_bytes: image.original_bytes,
        image_final_width: image.final_width,
        image_final_bytes: image.final_bytes,
        image_was_converted: image.was_converted,
      } : prev));
      const versionsRes = await fetchWithAuth(`/api/organizations/${orgId}/channel-posts/drafts/${draftId}/versions`);
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
    if (!orgId || !draft || !canPublish) return;
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
            ? t('channelPostsRateLimitedUntil', { time: new Date(info.resetAt).toLocaleString() })
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
        setCancelScheduledResult({ type: 'error', text });
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
        const text = info.kind === 'scope_insufficient'
          ? (role === 'owner' ? t('channelPostsUnpublishScopeInsufficientOwner') : t('channelPostsUnpublishScopeInsufficientNonOwner'))
          : info.humanMessageKey ? t(info.humanMessageKey) : (info.humanMessageFallback || t('channelPostsUnpublishFailed'));
        setUnpublishResult({ type: 'error', text });
      }
    } catch {
      setUnpublishResult({ type: 'error', text: t('channelPostsUnpublishFailed') });
    } finally {
      setUnpublishing(false);
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

  // 회수 버튼 — 발행됨 상태 + 연결이 이 채널의 회수를 지원(can_unpublish) + role 게이팅.
  // unpublishGate===undefined(연결 조회 전/실패)면 "모른다"로 두고 버튼을 비활성화한다
  // (§3-2와 같은 축 — 모르는 것을 근거로 허용하지 않는다, fail-closed).
  const showUnpublish = draft.publication_status === 'published';
  const canUnpublishNow = canUnpublish && unpublishGate?.canUnpublish === true;

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6 p-6">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold text-foreground">{t('editTitle')}</h1>
        <p className="text-sm text-muted-foreground">
          {draft.channel === 'threads' ? t('channelThreads') : draft.channel} · v{draft.current_version}
        </p>
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
              src={draft.thumbnail_url} alt="" className="h-32 w-32 rounded object-cover"
              data-testid="channel-post-approval-thumbnail"
            />
            {draft.image_was_converted ? (
              <p className="text-xs text-muted-foreground" data-testid="channel-post-image-converted-badge">
                {t('channelPostsImageConvertedBadge', {
                  originalWidth: draft.image_original_width ?? 0,
                  finalWidth: draft.image_final_width ?? 0,
                  originalBytes: typeof draft.image_original_bytes === 'number' ? formatMegabytes(draft.image_original_bytes) : '',
                  finalBytes: typeof draft.image_final_bytes === 'number' ? formatMegabytes(draft.image_final_bytes) : '',
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
                  <span>{new Date(draft.published_at).toLocaleString()}</span>
                </div>
              ) : null}
              {draft.external_id ? (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground" data-testid="channel-post-external-id-label">{t('channelPostsExternalIdLabel')}</span>
                  <span data-testid="channel-post-external-id">{draft.external_id}</span>
                </div>
              ) : null}
            </div>
          );
        }
        if (view.partialSuccess) {
          return (
            <Alert role="status" data-testid="channel-post-partial-success-notice">
              <AlertDescription>{t('channelPostsPartialSuccessNotice')}</AlertDescription>
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
        if (view.unpublished) {
          // story #3426(doc §17-10②) — 회수돼도 승인(gate) 자체는 안 풀린다 — 칩은
          // 「승인됨」 그대로이고 이 오버레이가 "회수됨"을 얹는다(partialSuccess/
          // publicationFailed와 같은 자리).
          return (
            <Alert role="status" data-testid="channel-post-unpublished-notice">
              <AlertDescription>{t('channelPostsUnpublishedNotice')}</AlertDescription>
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
          <Button onClick={() => void handlePublish()} disabled={!canPublish || publishing} data-testid="channel-post-publish-button">
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
        {showCancelScheduled && !canCancelScheduled ? (
          <p className="text-xs text-muted-foreground" data-testid="channel-post-cancel-scheduled-disabled-reason">
            {t('channelPostsCancelUnpublishOwnerOrAdminOnly')}
          </p>
        ) : null}
        {/* doc §17-11 정본 — unsupported는 대상 아님(문구 없음, 버튼도 없음 — 없는 자리를
            안 그린다). scope_insufficient만 role별 두 문장(owner: 재연결하면 풀림 /
            member: owner에게 요청). role 게이팅(owner/admin 아님)이 blocked_reason보다
            먼저 걸리면 그 사유가 우선(§17-11은 "권한은 있는데 스코프가 없다"는 경우 전용). */}
        {showUnpublish && !canUnpublish ? (
          <p className="text-xs text-muted-foreground" data-testid="channel-post-unpublish-disabled-reason">
            {t('channelPostsCancelUnpublishOwnerOrAdminOnly')}
          </p>
        ) : showUnpublish && canUnpublish && unpublishGate?.blockedReason === 'scope_insufficient' ? (
          <p className="text-xs text-muted-foreground" data-testid="channel-post-unpublish-disabled-reason">
            {role === 'owner' ? t('channelPostsUnpublishScopeInsufficientOwner') : t('channelPostsUnpublishScopeInsufficientNonOwner')}
          </p>
        ) : showUnpublish && canUnpublish && unpublishGate === undefined ? (
          // 페드루 PO nit(2026-09-04 09:07Z) — 연결 조회 자체가 실패/아직 안 끝났으면
          // "모른다"인데 버튼만 비활성이고 이유가 없었다(AC1 "사유는 버튼 밖" 규율 위반).
          <p className="text-xs text-muted-foreground" data-testid="channel-post-unpublish-disabled-reason">
            {t('channelPostsUnpublishGateUnknown')}
          </p>
        ) : null}
        {publishResult ? (
          <Alert variant={publishResult.type === 'error' ? 'destructive' : 'default'} role={publishResult.type === 'error' ? 'alert' : 'status'} data-testid="channel-post-publish-result">
            <AlertDescription>
              {publishResult.type === 'success'
                ? t('publishSuccess', { time: draft.published_at ? new Date(draft.published_at).toLocaleString() : '' })
                : publishResult.type === 'scheduled'
                  ? t('channelPostsPublishScheduled', { time: publishResult.scheduledAt ? new Date(publishResult.scheduledAt).toLocaleString() : t('originAuthorUnknown') })
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
        <input
          value={linkUrl}
          onChange={(e) => setLinkUrl(e.target.value)}
          placeholder="https://…"
          className="w-full rounded-md border border-border p-2 text-sm"
          data-testid="channel-post-link-field"
        />
      </div>

      {/* story #3428(T3-M·§17-16) — image_max_count<=0(미지원 채널, 또는 아직 모른다)
          이면 첨부 칸 자체를 그리지 않는다. 규격 태그는 어댑터 선언값 그대로(하드코딩
          금지 축) — 값을 지어내지 않는다. */}
      {imageSpec && imageSpec.maxCount > 0 ? (
        <div className="space-y-2 rounded-md border border-border p-3 text-sm" data-testid="channel-post-image-attach">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">{t('channelPostsImageAttachLabel', { count: imageSpec.maxCount })}</span>
          </div>
          <p className="text-xs text-muted-foreground" data-testid="channel-post-image-spec-tag">
            {t('channelPostsImageSpecTag', {
              formats: imageSpec.formats.map((f) => f.replace('image/', '').toUpperCase()).join(', '),
              maxBytes: formatMegabytes(imageSpec.maxBytes),
              aspectMax: imageSpec.aspectMax,
              widthMin: imageSpec.widthMin,
              widthMax: imageSpec.widthMax,
            })}
          </p>
          {draft.thumbnail_url ? (
            // eslint-disable-next-line @next/next/no-img-element -- story #3428: public-read GCS 오브젝트 URL(외부 도메인, next/image 대상 밖 — avatar_upload.py 소비부와 동형 관례).
            <img src={draft.thumbnail_url} alt="" className="h-24 w-24 rounded object-cover" data-testid="channel-post-image-preview" />
          ) : null}
          <input
            type="file"
            accept={imageSpec.formats.join(',')}
            data-testid="channel-post-image-file-input"
            disabled={imageUploadStatus.phase === 'requesting_url' || imageUploadStatus.phase === 'uploading' || imageUploadStatus.phase === 'confirming'}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void handleImageFileSelected(file);
            }}
          />
          {imageUploadStatus.phase === 'requesting_url' || imageUploadStatus.phase === 'uploading' || imageUploadStatus.phase === 'confirming' ? (
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
            </Alert>
          ) : null}
        </div>
      ) : null}

      {saveMessage ? (
        <Alert variant={saveMessage.type === 'error' ? 'destructive' : 'default'} role="status">
          <AlertDescription>{saveMessage.text}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex gap-2">
        <Button onClick={handleSave} disabled={saving} data-testid="channel-post-save-button">
          {saving ? t('editSavingCta') : t('editSaveCta')}
        </Button>
        <Button
          onClick={handleSubmitForApproval}
          disabled={submitting || isOverLimit}
          data-testid="channel-post-submit-button"
        >
          {submitting ? t('submitPendingCta') : t('submitCta')}
        </Button>
      </div>
      {/* AC6 — 비활성 이유는 버튼 밖에 둔다(라벨 안에 넣으면 disabled:opacity-50에
          워시된다, Phase 0 실측). */}
      {isOverLimit ? (
        <p className="text-xs text-muted-foreground" data-testid="channel-post-over-limit-reason">
          {t('channelPostsOverLimitReason')}
        </p>
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
          </Alert>
        )
      ) : null}
    </div>
  );
}
