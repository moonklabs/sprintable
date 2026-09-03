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
  contentPostStatusLabelKey,
  CONTENT_POST_STATUS_TONE,
} from '@/components/content/post-status';
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

  // 오늘 시점(S2 봉인 전) — 게이트 신호가 아직 없어 항상 'draft'로 파생된다(post-status.ts 참조).
  const status = deriveContentPostStatus({});
  const tone = CONTENT_POST_STATUS_TONE[status];

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold text-foreground">{t('editTitle')}</h1>
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${tone.bg} ${tone.text}`}>
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} aria-hidden="true" />
            {t(contentPostStatusLabelKey(status))}
          </span>
          <Badge variant="outline">v{latest.version}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {t('editMeta', { slug: latest.slug, lang: latest.lang })}
        </p>
      </div>

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

        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">{t('fieldLastEditedBy')}</p>
          <p className="text-sm text-muted-foreground">
            {latest.author_kind === 'agent' ? t('authorAgent') : t('authorHuman')}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => void handleSave()} disabled={saving}>
            {saving ? t('editSavingCta') : t('editSaveCta')}
          </Button>
          <Button type="button" variant="outline" onClick={() => void handleSubmitForApproval()} disabled={saving || submitting}>
            {submitting ? t('submitPendingCta') : t('submitCta')}
          </Button>
        </div>
      </div>
    </div>
  );
}
