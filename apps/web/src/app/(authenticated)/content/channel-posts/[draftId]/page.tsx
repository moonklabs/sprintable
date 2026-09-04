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
}

// story #3402 ④(AC7) — 한도 잔량은 조회값이고 조회 실패도 상태다. success=false는
// "0"이 아니라 "못 쟀다"를 뜻한다(§3-2 "모른다를 다르다로 접지 않는다") — 발행 버튼을
// 막는 근거로 쓰지 않는다(이 화면엔 발행 버튼 자체가 없다, PR2 몫).
type PublishingLimitState =
  | { status: 'loading' }
  | { status: 'ok'; quotaUsage: number; quotaTotal: number; checkedAt: string }
  | { status: 'failed' };

export default function ChannelPostEditPage() {
  const { orgId } = useDashboardContext();
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
        // story #3402·PR#3764 — CHANNEL_POST_GATE_ALREADY_HELD. site와 kind는 공유하되
        // slug/lang이 없다(채널 포스트 모델 자체에 title이 없다) — heldByChannel+
        // heldByConnectionId 앞 4자로 "Threads 초안 ····a1b2" 폴백을 조립한다(doc §5 각주,
        // 전체 UUID는 화면에 안 남긴다). ⛔"합치기"류 문구는 쓰지 않는다(제품에 없는
        // 동작 — doc §5 각주 명시).
        if (info.kind === 'gate_already_held' && info.heldByDraftId) {
          const shortId = info.heldByConnectionId ? info.heldByConnectionId.slice(0, 4) : info.heldByDraftId.slice(0, 4);
          // ⚠️heldByChannel은 서버 원문 채널 코드('threads', 소문자)다 — 화면 다른 자리와
          // 같은 표시 매핑(channel==='threads' ? t('channelThreads') : channel)을 거치지
          // 않으면 이 문구만 원문 코드가 그대로 새는 불일치가 생긴다(테스트가 실제로 잡음).
          const channelLabel = info.heldByChannel === 'threads' ? t('channelThreads') : (info.heldByChannel ?? t('channelThreads'));
          const fallbackLabel = `${channelLabel} 초안 ····${shortId}`;
          setSubmitResult({
            type: 'error',
            text: fallbackLabel,
            raw: info.raw,
            heldByDraftId: info.heldByDraftId,
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

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6 p-6">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold text-foreground">{t('editTitle')}</h1>
        <p className="text-sm text-muted-foreground">
          {draft.channel === 'threads' ? t('channelThreads') : draft.channel} · v{draft.current_version}
        </p>
      </div>

      {/* story #3402 ④ — 승인 카드(T5/T6). AC8(UTM 미리보기)·AC9(계정 표시)·AC7(한도
          잔량, 조회 실패도 상태). 게이트 상태 자체는 목록과 같은 gate_status/
          reapproval_required 신호(#3394)를 그대로 읽는다 — 별도 조회 없음. */}
      <div className="space-y-2 rounded-md border border-border p-4 text-sm" data-testid="channel-post-approval-card">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">{t('channelPostsApprovalStatusLabel')}</span>
          <span data-testid="channel-post-gate-status">
            {draft.gate_status == null
              ? t('channelPostsApprovalNotSubmitted')
              : draft.gate_status === 'pending' && draft.reapproval_required
                ? t('channelPostsApprovalReapprovalNeeded')
                : draft.gate_status === 'pending'
                  ? t('channelPostsApprovalPending')
                  : draft.gate_status === 'approved'
                    ? t('channelPostsApprovalApproved')
                    : t('channelPostsApprovalNotSubmitted')}
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
