'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { EmptyState } from '@/components/ui/empty-state';
import { fetchWithAuth } from '@/lib/db/client';
import { channelLabel } from '@/lib/channel-label';
import { formatRelativeTime } from '@/lib/storage/format';
import { resolveDisplayTimezone } from '@/components/content/schedule-format';
import { deriveChannelPostView, type ChannelPublicationStatus } from '@/components/content/channel-post-status';
import { type ContentPostStatusInput } from '@/components/content/post-status';
import { StatusChip } from '@/components/content/status-chip';
import { AuthorKindBadge } from '@/components/content/author-kind-badge';
import { isSandboxChannelDraft, SandboxTestBadge } from '@/components/content/sandbox-test-badge';

/**
 * story #3402(Phase1·마케팅운영, AC1/AC2/AC3, doc phase1-threads-post-manager-screen-design
 * §2·§4-1 — 와이어프레임 T1) — 채널 포스트(Threads 등) 목록. content/page.tsx(site-posts)와
 * 동형 구조지만 세 가지가 다르다:
 *   ① 「새 글」 버튼이 없다(doc §2 — 초안은 에이전트가 API로만 만든다), 빈 상태 문구도 다르다.
 *   ② 계약(ChannelPostDraftListItem, story #3394)에 `title`/`text` 자체가 없다(모델이
 *      channel·text·link_url만 가진다) — 행의 식별 표시는 channel + version이다(지어내지
 *      않는다, 없는 title을 만들지 않는다).
 *   ③ 다섯 상태 파생 위에 publication_status(부분 성공/실패, doc §4-1 — 다섯 상태 밖의
 *      여섯 번째 신호)를 deriveChannelPostView로 오버레이한다(post-status.ts 자체는 무변경,
 *      PO 결정 2026-09-03 23:19Z).
 */

interface ChannelPostDraftListItem {
  draft_id: string;
  work_item_id: string;
  channel: string;
  connection_id: string;
  current_version: number;
  latest_author_kind: 'agent' | 'human';
  origin_author_kind?: 'agent' | 'human' | null;
  updated_at: string;
  gate_status?: string | null;
  reapproval_required?: boolean | null;
  sealed_content_sha256?: string | null;
  body_sha256: string;
  published_at?: string | null;
  published_body_sha256?: string | null;
  publication_status?: ChannelPublicationStatus | null;
  permalink?: string | null;
  external_id?: string | null;
  error_code?: string | null;
  // story #3402(페드루 PO 지시, 2026-09-04 01:39Z) — 디디군의 작은 후속 PR로 곧 착지 예정인
  // 계약(80자 본문 첫 줄 미리보기 + 글자 수). 착지 전(지금)엔 두 필드 다 응답에 없다 — AC2와
  // 같은 규율로 "키 부재≠null": 없으면 지어내지 않고 「—」를 그린다(채널+버전으로만 식별하던
  // 임시 표시가 착지 즉시 자동으로 실제 본문 미리보기로 바뀐다, 이 페이지는 수정 불필요).
  text_preview?: string | null;
  text_length?: number | null;
  // story #3457 후속(BE #3817 착지분) — "같은 스토리의 글"(§14-2 안전 표기) 보조줄.
  // source_content_item_id가 없으면(정상값) 그 줄 자체를 안 그린다.
  source_content_item_id?: string | null;
  source_title?: string | null;
}

// content/page.tsx::toGateStatus와 동형.
function toGateStatus(status: string | null | undefined): ContentPostStatusInput['gateStatus'] {
  return status === 'pending' || status === 'approved' || status === 'rejected' ? status : undefined;
}

function realStr(v: string | null | undefined): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export default function ChannelPostListPage() {
  const { orgId } = useDashboardContext();
  const t = useTranslations('content');
  const locale = useLocale();
  const displayTimezone = resolveDisplayTimezone().tz;

  const [drafts, setDrafts] = useState<ChannelPostDraftListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      setLoadError(false);
      try {
        const res = await fetchWithAuth(`/api/organizations/${orgId}/channel-posts/drafts`);
        if (cancelled) return;
        if (res.ok) {
          const json = (await res.json().catch(() => null)) as { data?: ChannelPostDraftListItem[] } | null;
          setDrafts(json?.data ?? []);
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
  }, [orgId]);

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-6">
      {/* story #3422 ③-b(doc §11 T8) — 캘린더 화면 진입점. 목록/캘린더는 같은 데이터를
          다른 축(최신순 목록 vs 채널×날짜 격자)으로 보는 것이라 탭이 아니라 링크로
          충분하다(별도 nav 계층을 새로 안 만든다). */}
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold text-foreground">{t('channelPostsTitle')}</h1>
          <p className="text-sm text-muted-foreground">{t('channelPostsDescription')}</p>
        </div>
        <Link href="/content/channel-posts/calendar" className="shrink-0 text-sm text-foreground underline underline-offset-4" data-testid="channel-posts-calendar-link">
          {t('channelPostsCalendarLinkCta')}
        </Link>
      </div>

      {loadError ? (
        <Alert variant="destructive" role="alert" aria-live="assertive" aria-atomic="true">
          <AlertDescription>{t('channelPostsLoadFailed')}</AlertDescription>
        </Alert>
      ) : null}

      {loading ? (
        <div className="space-y-3" data-testid="channel-posts-list-loading">
          {[1, 2, 3].map((i) => <div key={i} className="h-12 animate-pulse rounded-md bg-muted" />)}
        </div>
      ) : drafts.length === 0 ? (
        // doc §2 — "새 글" 버튼이 없다: 초안은 에이전트가 API로만 만든다.
        !loadError ? <EmptyState title={t('channelPostsEmptyTitle')} description={t('channelPostsEmptyDescription')} /> : null
      ) : (
        <div className="overflow-hidden rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                {/* story #3402(PO 지시 2026-09-04) — text_preview/text_length는 디디군의
                    작은 후속 PR로 곧 착지 예정. 착지 전엔 응답에 필드 자체가 없어(AC2와
                    같은 "키 부재≠null" 규율) 이 두 열은 「—」로 떨어진다 — 착지 즉시 이
                    페이지 수정 없이 실제 본문 미리보기·글자 수가 자동으로 채워진다. */}
                <th className="px-3 py-2 text-left font-medium">{t('channelPostsColumnPreview')}</th>
                <th className="px-3 py-2 text-left font-medium">{t('channelPostsColumnChannel')}</th>
                <th className="px-3 py-2 text-left font-medium">{t('channelPostsColumnStatus')}</th>
                <th className="px-3 py-2 text-left font-medium">{t('channelPostsColumnVersion')}</th>
                <th className="px-3 py-2 text-left font-medium">{t('channelPostsColumnTextLength')}</th>
                <th className="px-3 py-2 text-left font-medium">{t('channelPostsColumnOriginAuthor')}</th>
                <th className="px-3 py-2 text-left font-medium">{t('channelPostsColumnAuthor')}</th>
                <th className="px-3 py-2 text-left font-medium">{t('channelPostsColumnUpdatedAt')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {drafts.map((draft) => {
                // AC2 — 계약 필드(gate_status) 자체가 없으면 파생을 아예 부르지 않고 판별
                // 불가(undefined)로 둔다(content/page.tsx와 동형 규율).
                const hasGateContract = 'gate_status' in draft;
                const view = hasGateContract
                  ? deriveChannelPostView({
                      gateStatus: toGateStatus(draft.gate_status),
                      reapprovalRequired: draft.reapproval_required ?? undefined,
                      sealedBodySha256: realStr(draft.sealed_content_sha256),
                      currentBodySha256: draft.body_sha256,
                      publicationStatus: draft.publication_status ?? undefined,
                      errorCode: draft.error_code,
                      publishedAt: 'published_at' in draft ? draft.published_at : undefined,
                    })
                  : { status: undefined, partialSuccess: false, publicationFailed: false };
                const hasTextPreview = 'text_preview' in draft && draft.text_preview != null;
                const hasTextLength = 'text_length' in draft && draft.text_length != null;
                return (
                  <tr key={draft.draft_id} data-testid="channel-posts-list-row">
                    <td className="max-w-xs truncate px-3 py-2.5 font-medium text-foreground">
                      <Link href={`/content/channel-posts/${draft.draft_id}`} className="hover:underline">
                        {hasTextPreview
                          ? draft.text_preview
                          : `${channelLabel(draft.channel, t)} · v${draft.current_version}`}
                      </Link>
                      {/* AC3 — 부분 성공/실패는 다섯 상태 밖의 신호라 칩과 별도로 보인다
                          (doc §4-1 "이것은 다섯 상태 어디에도 없다"). */}
                      {/* AC12 — 소형 텍스트에 계열색 직접 금지(§6-2-1) — StatusChip과 같은
                          패턴(배경 tint + text-foreground)으로 대비를 확保한다. */}
                      {view.partialSuccess ? (
                        <span
                          className="ml-2 rounded-full bg-warning-tint px-1.5 py-0.5 text-xs text-foreground"
                          data-testid="channel-post-partial-success"
                        >
                          {t('channelPostsPartialSuccess')}
                        </span>
                      ) : null}
                      {view.publicationFailed ? (
                        <span
                          className="ml-2 rounded-full bg-destructive-tint px-1.5 py-0.5 text-xs text-foreground"
                          data-testid="channel-post-publication-failed"
                        >
                          {t('channelPostsPublicationFailed')}
                        </span>
                      ) : null}
                      {/* story #3457 후속(유나 §14-2 안전 표기, PO 확定 2026-09-04 20:54Z) —
                          캘린더 카드·목록 행·상세 3곳이 같은 어휘. source_title 없으면(정상값,
                          단독 글 또는 아직 못 읽음) 이 줄 자체를 안 그린다. */}
                      {draft.source_content_item_id && draft.source_title ? (
                        <p className="mt-0.5 truncate text-xs text-muted-foreground" data-testid="channel-post-source-link">
                          {t('channelPostsSourceLabel')}{' '}
                          <Link href={`/content/${draft.source_content_item_id}`} className="underline">
                            {t('channelPostsSourceLinkText', { title: draft.source_title })}
                          </Link>
                        </p>
                      ) : null}
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground">
                      {channelLabel(draft.channel, t)}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <StatusChip status={view.status} />
                        {/* story f30da19a AC5 — T1(목록). §17-1 오버레이(칩은 그대로,
                            얹는다) — sandbox 연결로 만든 초안임을 진짜 초안과 나란히
                            구별한다(승인·발행 게이트 오통과 방지). */}
                        {isSandboxChannelDraft(draft.channel) ? <SandboxTestBadge /> : null}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground">v{draft.current_version}</td>
                    <td className="px-3 py-2.5 text-muted-foreground" data-testid="channel-post-text-length">
                      {hasTextLength ? draft.text_length : t('originAuthorUnknown')}
                    </td>
                    <td className="px-3 py-2.5" data-testid="channel-post-origin-author">
                      <AuthorKindBadge kind={draft.origin_author_kind} />
                    </td>
                    <td className="px-3 py-2.5" data-testid="channel-post-latest-author">
                      <AuthorKindBadge kind={draft.latest_author_kind} />
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground">
                      {formatRelativeTime(draft.updated_at, locale, displayTimezone)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
