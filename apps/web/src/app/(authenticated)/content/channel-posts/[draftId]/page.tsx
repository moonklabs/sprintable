'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { fetchWithAuth } from '@/lib/db/client';
import { channelTextLength } from '@/components/content/channel-text-length';
import { parseSitePostApiError } from '@/components/content/api-error';
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
}

// story #3402 ④(AC7) — 한도 잔량은 조회값이고 조회 실패도 상태다. success=false는
// "0"이 아니라 "못 쟀다"를 뜻한다(§3-2 "모른다를 다르다로 접지 않는다") — 발행 버튼을
// 막는 근거로 쓰지 않는다(이 화면엔 발행 버튼 자체가 없다, PR2 몫).
type PublishingLimitState =
  | { status: 'loading' }
  | { status: 'ok'; quotaUsage: number; quotaTotal: number; checkedAt: string }
  | { status: 'failed' };

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
    : { status: undefined, publishable: false, partialSuccess: false, publicationFailed: false, errorCode: undefined };

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
        return null;
      })()}

      {/* story #3402 PR2 ②-a/②-b — 발행 버튼. AC5 — 비활성 사유 문구는 버튼 밖에 둔다
          (라벨 안에 넣으면 disabled:opacity-50에 워시된다, Phase 0 실측 그대로 재사용).
          ⚠️발행 취소 버튼은 PR2에서 화면에 렌더하지 않는다(페드루 PO 판정, 2026-09-04
          05:37Z) — backend/app/routers/channel_posts.py에 unpublish 엔드포인트
          자체가 없어(grep 0건, site-posts만 있음) 게이팅만 선 죽은 버튼을 표면에
          두면 안 된다는 판단. canUnpublish 변수·테스트는 남겨 둔다(BE 경로가 오면
          이 조건 하나로 버튼을 다시 켠다 — 예약 명령 취소+발행 글 회수 두 경로,
          PR#3769 뒤 디디군 착수 예정). */}
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
          {/* story #3426 ①-b — 예약 취소·회수 버튼(게이팅만, API 배선은 ①-c). PR2에서
              렌더 보류했던 「발행 취소」 버튼을 BE #3419 착지로 복원한다. */}
          {showCancelScheduled ? (
            <Button variant="outline" disabled={!canCancelScheduled} data-testid="channel-post-cancel-scheduled-button">
              {t('channelPostsCancelScheduledCta')}
            </Button>
          ) : null}
          {showUnpublish && unpublishGate?.blockedReason !== 'unsupported' ? (
            <Button variant="outline" disabled={!canUnpublishNow} data-testid="channel-post-unpublish-button">
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
            {role === 'owner' ? t('channelPostsUnpublishScopeInsufficientOwner') : t('channelPostsUnpublishScopeInsufficientMember')}
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
