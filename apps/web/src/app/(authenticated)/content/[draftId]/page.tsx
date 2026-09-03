'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { fetchWithAuth } from '@/lib/db/client';
import {
  deriveContentPostStatus,
  type ContentPostStatusInput,
} from '@/components/content/post-status';
import { StatusChip } from '@/components/content/status-chip';
import { AuthorKindBadge } from '@/components/content/author-kind-badge';
import { parseSitePostApiError } from '@/components/content/api-error';

/**
 * story #3368(Phase0·마케팅운영 S4, doc phase0-post-manager-screen-design §8-1 순서 3번) —
 * 글 편집(와이어프레임 S3·S4). slug·lang은 첫 버전 뒤 잠근다(페드루 정정 2026-09-03: 서버가
 * (org, work_item_id, slug)로 기존 초안을 매칭하므로 slug를 바꾸면 새 초안이 생겨 이력이
 * 갈라진다) — 편집 가능한 필드는 title·summary·tags·body_md뿐이다.
 *
 * ⚠️원안/수정본 대조 패널(와이어프레임 S4)은 이 슬라이스에 없다 — §8-1 명시: "4·6이 봉인
 * 해시(BE §4-3 3번)에 걸려 있다 ... 4·6은 BE 봉인이 착지한 뒤에 시작한다." 오늘은 최신
 * 버전 단일 폼만 그린다.
 *
 * 승인 요청(와이어프레임 S5) — 페드루 PO 판정(2026-09-03): FE가 generic `POST /gates`에
 * role_id를 지어 넣지 않는다(계약 갭, gates.py::GateCreateRequest가 role_id 필수인데
 * eligible-approvers 응답엔 없음). 대신 디디군 S2 전용 엔드포인트 계약으로 stub 배선한다
 * (`POST .../drafts/{draft_id}/submit`, role_id 해소·게이트 pending 생성·봉인은 전부
 * 서버 책임) — S2 착지 전까지는 404가 그대로 뜬다(정상, 계약 stub). 성공하면 gate_id로
 * `/gates/{id}` 딥링크(§6-1 재사용 목록, 게이트 상세)한다.
 */

interface SitePostVersion {
  version_id: string;
  version: number;
  slug: string;
  source_story_id: string;
  title: string;
  lang: string;
  summary: string;
  tags: string[];
  body_md: string;
  body_sha256: string;
  author_member_id: string;
  author_kind: 'agent' | 'human';
  created_at: string;
}

// story #3368 §8-1 4단(페드루 지시 2026-09-03) — 이 work item의 external_publish
// 게이트. GET /api/gates?work_item_id=&work_item_type=는 기존 범용 라우트(doc-gate-
// section.tsx와 동형 재사용, 새 엔드포인트 0). 봉인 필드는 neutral_facts가 아니라 Gate
// 전용 컬럼 4종이다(S2, PR#3733 — GateResponse가 Gate ORM 컬럼명 그대로 top-level에
// 얹는다, gates.py::GateResponse).
interface GateInfo {
  id: string;
  status: string;
  sealed_content_version?: number | null;
  sealed_content_sha256?: string | null;
  sealed_content_body?: string | null;
  reapproval_required?: boolean;
}

function realStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

// Gate.status는 auto_passed/voided/held 등도 가질 수 있지만 Phase 0 external_publish는
// 휴먼 승인만 인정(auto_passed 도달 불가, doc phase0-post-manager-screen-design §3-1
// 각주) — pending/approved/rejected 셋 밖은 "유효한 승인 대상 없음"과 동형으로 undefined
// 처리해 deriveContentPostStatus가 'draft'로 안전하게 떨어지게 한다.
function toGateStatus(status: string | undefined): ContentPostStatusInput['gateStatus'] {
  return status === 'pending' || status === 'approved' || status === 'rejected' ? status : undefined;
}

// §4-1 "원문을 접어서 함께 보존한다" — gate_id 등 추적 정보를 사람 말 문구가 지워버리지
// 않게, 서버 원문(code+message)을 기본 접힌 <details>로 항상 옆에 둔다.
// col-start-2 — Alert의 grid-cols-[auto_1fr] 레이아웃에서 AlertDescription과 같은 칸에
// 서게 맞춘다. AlertDescription 자체는 <p>라 <details>(block)를 그 안에 못 넣는다(HTML
// 무효화) — 그래서 <p> 형제로 둔다.
function RawDetailsToggle({ raw, label }: { raw: string | undefined; label: string }) {
  if (!raw) return null;
  return (
    <details className="col-start-2 mt-1">
      <summary className="cursor-pointer text-xs text-muted-foreground">{label}</summary>
      <pre className="mt-1 overflow-x-auto rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">{raw}</pre>
    </details>
  );
}

export default function ContentPostEditPage() {
  const { draftId } = useParams<{ draftId: string }>();
  const { orgId } = useDashboardContext();
  const t = useTranslations('content');

  const [versions, setVersions] = useState<SitePostVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [tagsText, setTagsText] = useState('');
  const [bodyMd, setBodyMd] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<
    { type: 'success'; text: string } | { type: 'error'; text: string; raw?: string } | null
  >(null);

  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<
    { type: 'success'; gateId: string } | { type: 'error'; text: string; raw?: string } | null
  >(null);

  const [gate, setGate] = useState<GateInfo | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishResult, setPublishResult] = useState<
    // S3(story #3369) 계약 — url은 항상 온다(발행 URL을 서버가 조립·보증, 화면이 지어내지
    // 않는다). string | null이던 것은 레거시 endpoint(url 필드 자체가 없던 시절)의 흔적.
    | { type: 'success'; url: string; publishedAt: string }
    // reapprovalHashes — §8-3④-1(페드루 PO): 409 SITE_POST_REAPPROVAL_REQUIRED는 S10의
    // 일반 오류가 아니라 S9와 같은 처리(문구+해시 병치)여야 한다. 서버가 해시 값 자체를
    // 돌려주지 않아도(계약 미확정) 클라이언트가 이미 양쪽 해시를 갖고 있으니(gate 봉인
    // 해시·latest 현재 해시) 그걸로 병치한다 — 서버 응답을 지어내지 않는다.
    | { type: 'error'; text: string; raw?: string; reapprovalHashes?: { sealed?: string; current: string } }
    | null
  >(null);

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      setLoadError(false);
      try {
        const res = await fetchWithAuth(`/api/organizations/${orgId}/site-posts/drafts/${draftId}/versions`);
        if (cancelled) return;
        if (res.ok) {
          const json = (await res.json().catch(() => null)) as { data?: SitePostVersion[] } | null;
          const list = json?.data ?? [];
          setVersions(list);
          const latest = list[list.length - 1];
          if (latest) {
            setTitle(latest.title);
            setSummary(latest.summary);
            setTagsText(latest.tags.join(', '));
            setBodyMd(latest.body_md);
          }
        } else {
          setLoadError(true);
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

  const latest = versions[versions.length - 1];
  const workItemId = latest?.source_story_id;

  useEffect(() => {
    if (!orgId || !workItemId) return;
    let cancelled = false;
    async function loadGate() {
      try {
        const res = await fetchWithAuth(`/api/gates?work_item_id=${workItemId}&work_item_type=story`);
        if (cancelled || !res.ok) return;
        const list = (await res.json().catch(() => [])) as GateInfo[];
        const candidates = Array.isArray(list) ? list : [];
        // doc-gate-section.tsx::load()와 동형 관례 — 반려/대기 중인 게이트를 우선(진행
        // 상태가 있는 쪽이 사용자에게 더 중요), 없으면 최신(배열 첫 항목, 서버가
        // created_at desc로 준다는 기존 게이트 목록 관례 그대로).
        const picked = candidates.find((g) => g.status === 'pending' || g.status === 'rejected') ?? candidates[0] ?? null;
        setGate(picked);
      } catch {
        // best-effort — 게이트 조회 실패는 상태를 'draft'로 안전하게 떨어뜨릴 뿐 화면
        // 전체를 막지 않는다(목록/편집 자체는 게이트 유무와 무관하게 동작해야 함).
      }
    }
    void loadGate();
    return () => {
      cancelled = true;
    };
  }, [orgId, workItemId]);

  // story #3368 §3-1-2(페드루 PO 정정 2026-09-03 06:42Z) — 재승인 필요는 gate.
  // reapproval_required(서버 판정)를 그대로 읽는다. sealed_content_sha256은 이제 approved
  // 분기의 방어망 전용(정상 경로로는 도달 불가 — gates.py 가드가 이중 차단)이다.
  // publishable·blockedReason은 status와 다른 축: approved인데 봉인 값이 없어 "확인 불가"
  // 인 경우도 status는 approved로 남고 publishable만 false다(SEAL_MISSING).
  const { status: derivedStatus, publishable, blockedReason } = deriveContentPostStatus({
    gateStatus: toGateStatus(gate?.status),
    reapprovalRequired: gate?.reapproval_required,
    sealedBodySha256: realStr(gate?.sealed_content_sha256),
    currentBodySha256: latest?.body_sha256,
    hasPublishedSitePost: undefined, // S3(공개 projection) 착지 전 — 아직 판별 근거가 없다.
  });

  const handleSave = async () => {
    if (!orgId || !latest) return;
    setSaving(true);
    setSaveMessage(null);
    try {
      const tags = tagsText.split(',').map((s) => s.trim()).filter(Boolean);
      const res = await fetchWithAuth(`/api/organizations/${orgId}/site-posts/drafts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          work_item_id: latest.source_story_id,
          slug: latest.slug, // 잠김 — 항상 기존 값 그대로 재전송(서버 매칭 키).
          lang: latest.lang, // 잠김 — 동일.
          title, summary, tags, body_md: bodyMd, media_manifest: [],
        }),
      });
      if (res.ok) {
        setSaveMessage({ type: 'success', text: t('editSaved') });
        // 새 버전이 생겼다 — 이력을 다시 읽어 새 버전 번호·"미상신" 상태를 반영한다(AC2).
        const versionsRes = await fetchWithAuth(`/api/organizations/${orgId}/site-posts/drafts/${draftId}/versions`);
        if (versionsRes.ok) {
          const json = (await versionsRes.json().catch(() => null)) as { data?: SitePostVersion[] } | null;
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

  // story #3368 — 승인 요청(S5) 계약 stub(페드루 PO 판정 2026-09-03). 디디군 S2 착지 전까지
  // 404가 정상 응답이다 — 그 경우도 다른 에러와 동일하게 "사람 말+원문 보존"으로 렌더한다
  // (지어낸 성공 메시지로 덮지 않는다, AC7).
  const handleSubmitForApproval = async () => {
    if (!orgId || !latest) return;
    setSubmitting(true);
    setSubmitResult(null);
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgId}/site-posts/drafts/${draftId}/submit`, {
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
        setSubmitResult({
          type: 'error',
          text: info.humanMessageKey ? t(info.humanMessageKey) : (info.humanMessageFallback || t('submitFailed')),
          raw: info.raw,
        });
      }
    } catch {
      setSubmitResult({ type: 'error', text: t('submitFailed') });
    } finally {
      setSubmitting(false);
    }
  };

  // story #3368 §8-1 5단(와이어프레임 S7·S8)/#3369(S3) — 발행. canPublish===true일 때만
  // 호출 가능하게 UI가 막지만(아래 렌더), 서버(site_posts.py::publish_site_post_from_draft)
  // 가 최종 판정이다 — 화면 판단은 안내이지 방어가 아니다(§3-2).
  //
  // ⚠️페드루 PO 리뷰 정정(2026-09-03) — 레거시 `POST /organizations/{org}/site-posts`
  // (호출자가 본문 전체를 다시 보내는 agent 스크립트 시대 API, work_item_id/title/body_md
  // 등을 여기서 재조립)로 잘못 가고 있었다. 휴먼 발행은 draft 기반 신규 endpoint
  // (`.../drafts/{draftId}/publish`, S3)로 가야 한다 — 서버가 draft_id 하나로 최신 버전을
  // 직접 읽어 봉인을 재검증하므로 body가 필요 없다(화면이 본문을 다시 보낼수록 위조·구버전
  // 발행 위험만 는다). 성공 응답 {url, published_at, version_id}의 url은 이제 항상 온다
  // (S3 계약) — 지어내거나 옵셔널로 방어할 필요가 없다.
  const handlePublish = async () => {
    if (!orgId || !latest) return;
    setPublishing(true);
    setPublishResult(null);
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgId}/site-posts/drafts/${draftId}/publish`, {
        method: 'POST',
      });
      if (res.ok) {
        const json = (await res.json().catch(() => null)) as
          { data?: { url?: string; published_at?: string; version_id?: string } } | null;
        const publishedAt = json?.data?.published_at;
        const url = json?.data?.url;
        if (publishedAt && url) {
          setPublishResult({ type: 'success', publishedAt, url });
        } else {
          setPublishResult({ type: 'error', text: t('publishFailed'), raw: JSON.stringify(json) });
        }
      } else {
        const body = await res.json().catch(() => null);
        const info = parseSitePostApiError(body);
        setPublishResult({
          type: 'error',
          text: info.humanMessageKey ? t(info.humanMessageKey) : (info.humanMessageFallback || t('publishFailed')),
          raw: info.raw,
          reapprovalHashes: info.kind === 'reapproval_required'
            ? { sealed: sealedHash, current: latest.body_sha256 }
            : undefined,
        });
      }
    } catch {
      setPublishResult({ type: 'error', text: t('publishFailed') });
    } finally {
      setPublishing(false);
    }
  };

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-4 p-6">
        <div className="h-8 w-1/2 animate-pulse rounded-md bg-muted" />
        <div className="h-64 animate-pulse rounded-md bg-muted" />
      </div>
    );
  }

  if (loadError || !latest) {
    return (
      <div className="mx-auto w-full max-w-3xl p-6">
        <Alert variant="destructive" role="alert" aria-live="assertive" aria-atomic="true">
          <AlertDescription>{t('editLoadFailed')}</AlertDescription>
        </Alert>
      </div>
    );
  }

  const status = derivedStatus;
  const canPublish = publishable;
  const sealedHash = realStr(gate?.sealed_content_sha256);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold text-foreground">{t('editTitle')}</h1>
          <StatusChip status={status} />
          <Badge variant="outline">v{latest.version}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {t('editMeta', { slug: latest.slug, lang: latest.lang })}
        </p>
      </div>

      {status === 'reapproval_needed' ? (
        // §3-2 — "판정이 아니라 관측이다. 해시 두 개를 나란히 보여주면 사람이 스스로
        // 확인한다." 서버가 이미 게이트로 재승인을 강제한다(S3 착지 後) — 이 배너는
        // 방어가 아니라 안내다.
        <Alert variant="warning" role="status" aria-live="polite" aria-atomic="true">
          <AlertDescription>
            {t('reapprovalNeededNotice')}
            <br />
            <span className="font-mono text-xs">
              {t('reapprovalSealedHash')} {sealedHash ? `${sealedHash.slice(0, 12)}…` : '—'}
              {' · '}
              {t('reapprovalCurrentHash')} {latest.body_sha256.slice(0, 12)}…
            </span>
          </AlertDescription>
        </Alert>
      ) : null}

      {saveMessage && (
        <Alert
          variant={saveMessage.type === 'success' ? 'success' : 'destructive'}
          role={saveMessage.type === 'success' ? 'status' : 'alert'}
          aria-live={saveMessage.type === 'success' ? 'polite' : 'assertive'}
          aria-atomic="true"
        >
          <AlertDescription>{saveMessage.text}</AlertDescription>
          {saveMessage.type === 'error' ? <RawDetailsToggle raw={saveMessage.raw} label={t('errorRawDetailsToggle')} /> : null}
        </Alert>
      )}

      {submitResult && (
        <Alert
          variant={submitResult.type === 'success' ? 'success' : 'destructive'}
          role={submitResult.type === 'success' ? 'status' : 'alert'}
          aria-live={submitResult.type === 'success' ? 'polite' : 'assertive'}
          aria-atomic="true"
        >
          <AlertDescription>
            {submitResult.type === 'success' ? (
              <>
                {t('submitSuccess')}{' '}
                <Link href={`/gates/${submitResult.gateId}`} className="underline">{t('submitGateLink')}</Link>
              </>
            ) : (
              submitResult.text
            )}
          </AlertDescription>
          {submitResult.type === 'error' ? <RawDetailsToggle raw={submitResult.raw} label={t('errorRawDetailsToggle')} /> : null}
        </Alert>
      )}

      <div className="space-y-4">
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="post-title">{t('fieldTitle')}</label>
          <input
            id="post-title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={saving}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
          />
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="post-summary">{t('fieldSummary')}</label>
          <input
            id="post-summary"
            type="text"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            disabled={saving}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
          />
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="post-tags">{t('fieldTags')}</label>
          <input
            id="post-tags"
            type="text"
            value={tagsText}
            onChange={(e) => setTagsText(e.target.value)}
            disabled={saving}
            placeholder={t('fieldTagsPlaceholder')}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
          />
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="post-body">{t('fieldBody')}</label>
          <textarea
            id="post-body"
            value={bodyMd}
            onChange={(e) => setBodyMd(e.target.value)}
            disabled={saving}
            rows={16}
            className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm text-foreground"
          />
        </div>

        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">{t('fieldSlugLangLocked')}</p>
          <p className="text-sm text-muted-foreground">{latest.slug} · {latest.lang}</p>
          <p className="text-xs text-muted-foreground">{t('fieldSlugLangLockedHint')}</p>
        </div>

        <div className="flex flex-wrap gap-6">
          {/* 유나 §6-3-1 지적(2026-09-03 라이브 검수) — 목록엔 원작성·최종수정 둘 다 있는데
              편집 화면엔 최종수정만 있어 "원안이 에이전트였다"가 편집 중 안 보였다. */}
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">{t('fieldOriginAuthor')}</p>
            <AuthorKindBadge kind={versions[0]?.author_kind} />
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">{t('fieldLastEditedBy')}</p>
            <AuthorKindBadge kind={latest.author_kind} />
          </div>
        </div>

        <div className="space-y-1">
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => void handleSave()} disabled={saving}>
              {saving ? t('editSavingCta') : t('editSaveCta')}
            </Button>
            <Button type="button" variant="outline" onClick={() => void handleSubmitForApproval()} disabled={saving || submitting}>
              {submitting ? t('submitPendingCta') : t('submitCta')}
            </Button>
            <Button type="button" variant="outline" onClick={() => void handlePublish()} disabled={!canPublish || publishing}>
              {publishing ? t('publishPendingCta') : t('publishCta')}
            </Button>
          </div>
          {/* §6-2-1 — 비활성 발행 버튼 라벨 자체는 WCAG 면제 대상이지만, "눌리지 않는
              이유"를 옆에 두는 이 문구는 실제 정보라 4.5:1 판정 대상이다(text-muted-
              foreground on card 실측 5.92 — 통과, doc §6-2-1 그대로). */}
          {!canPublish ? (
            <p className="text-xs text-muted-foreground">
              {blockedReason === 'SEAL_MISSING' ? t('publishDisabledReasonSealMissing') : t('publishDisabledReason')}
            </p>
          ) : null}
        </div>
      </div>

      {publishResult && (
        <Alert
          variant={publishResult.type === 'success' ? 'success' : 'destructive'}
          role={publishResult.type === 'success' ? 'status' : 'alert'}
          aria-live={publishResult.type === 'success' ? 'polite' : 'assertive'}
          aria-atomic="true"
        >
          <AlertDescription>
            {publishResult.type === 'success' ? (
              <>
                {t('publishSuccess', { time: new Date(publishResult.publishedAt).toLocaleString() })}
                {' '}
                <a href={publishResult.url} target="_blank" rel="noopener noreferrer" className="underline">
                  {t('publishViewLink')}
                </a>
              </>
            ) : (
              <>
                {publishResult.text}
                {publishResult.reapprovalHashes ? (
                  // §8-3④-1 — 409 SITE_POST_REAPPROVAL_REQUIRED는 S10 일반 오류가 아니라
                  // S9와 같은 처리(문구+해시 병치)다. 판정이 아니라 관측(§3-2)이라 여기서도
                  // 그대로 — 해시 두 개를 나란히 보여주고 사람이 스스로 확인하게 한다.
                  <>
                    <br />
                    <span className="font-mono text-xs">
                      {t('reapprovalSealedHash')} {publishResult.reapprovalHashes.sealed ? `${publishResult.reapprovalHashes.sealed.slice(0, 12)}…` : '—'}
                      {' · '}
                      {t('reapprovalCurrentHash')} {publishResult.reapprovalHashes.current.slice(0, 12)}…
                    </span>
                  </>
                ) : null}
              </>
            )}
          </AlertDescription>
          {publishResult.type === 'error' ? <RawDetailsToggle raw={publishResult.raw} label={t('errorRawDetailsToggle')} /> : null}
        </Alert>
      )}
    </div>
  );
}
