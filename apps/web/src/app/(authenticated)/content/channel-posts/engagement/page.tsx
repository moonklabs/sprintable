'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { getEntityHref } from '@/components/chat/embed-card';
import { fetchWithAuth } from '@/lib/db/client';
import { channelLabel } from '@/lib/channel-label';
import { formatRelativeTime } from '@/lib/storage/format';
import { resolveDisplayTimezone } from '@/components/content/schedule-format';
import { CommentReplyDialog, type CommentReplyOutcome } from '@/components/content/comment-reply-dialog';
import { CommentConvertToTaskDialog } from '@/components/content/comment-convert-to-task-dialog';
import type { CommentItem } from '@/components/content/comments-section';

/**
 * story #3805(Phase3·3-1·PR 2[FE], 유나 §절·08:14Z/08:40Z 낱말·범위 정정) — 「반응」
 * (Engagement) 화면. PO 判(08:40Z): PR 1 BE 계약이 댓글 전용이라(그라운딩 불일치 flag
 * 채택) 「종류」 열·칩·필터는 이번 PR에서 아예 그리지 않는다(답글 항목화=같은 카드
 * PR 3). 채널 포스트 화면의 뷰 하나(목록·캘린더 옆) — 새 사이드바 항목 0.
 *
 * 답변/작업 전환은 comments-section.tsx가 이미 쓰는 CommentReplyDialog/
 * CommentConvertToTaskDialog를 그대로 재사용한다(새 다이얼로그 0). 두 컴포넌트는
 * comments-section의 풍부한 CommentItem(replyStatus 등 답변 상세)을 기대하지만
 * 이 큐의 목록 계약(GET .../engagement/items)엔 그 필드가 없다 — 다이얼로그를 열 때만
 * 그 필드들을 "아직 모름"(null/0) 기본값으로 채운다. 그 자체가 새 사실을
 * 지어내는 게 아니라 다이얼로그가 실제로 쓰는 값(sentRepliesCount 배너 등)만
 * 정확성이 낮아질 뿐이라 fail-closed로 안전한 방향(과소 표시)이다.
 */

const TRIAGE_STATUSES = ['open', 'in_progress', 'done', 'skipped'] as const;
type TriageStatus = (typeof TRIAGE_STATUSES)[number];

const STATUS_LABEL_KEY: Record<TriageStatus, string> = {
  open: 'engagementStatusOpen',
  in_progress: 'engagementStatusInProgress',
  done: 'engagementStatusDone',
  skipped: 'engagementStatusSkipped',
};

// 유나 §절7 — 강조(주의)·정보·성공(muted)·중립. 빨강 금지(빨강=파괴/kill 전용).
const STATUS_TONE: Record<TriageStatus, { bg: string; text: string; dot: string }> = {
  open: { bg: 'bg-amber-100 dark:bg-amber-950/40', text: 'text-amber-800 dark:text-amber-300', dot: 'bg-amber-500' },
  in_progress: { bg: 'bg-sky-100 dark:bg-sky-950/40', text: 'text-sky-800 dark:text-sky-300', dot: 'bg-sky-500' },
  done: { bg: 'bg-emerald-100/70 dark:bg-emerald-950/30', text: 'text-emerald-700/90 dark:text-emerald-400/90', dot: 'bg-emerald-500' },
  skipped: { bg: 'bg-muted', text: 'text-muted-foreground', dot: 'bg-muted-foreground' },
};

interface EngagementItem {
  id: string;
  publication_id: string;
  channel: string;
  external_comment_id: string;
  author_display_name: string | null;
  text: string;
  captured_at: string;
  triage_status: string;
  assignee_member_id: string | null;
  linked_story_id: string | null;
}

interface EngagementListResponse {
  items: EngagementItem[];
  has_more: boolean;
  next_cursor: string | null;
}

interface CollectionStatusItem {
  connection_id: string;
  channel: string;
  account_label: string | null;
  last_collected_at: string | null;
}

interface OrgMemberOption {
  id: string;
  name: string;
}

async function readJson<T>(res: Response): Promise<T | null> {
  const body = (await res.json().catch(() => null)) as { data?: T } | null;
  return body?.data ?? null;
}

export default function ChannelPostsEngagementPage() {
  const router = useRouter();
  const { orgId, orgTimezone } = useDashboardContext();
  const t = useTranslations('content');
  const locale = useLocale();
  const displayTimezone = resolveDisplayTimezone(orgTimezone).tz;

  const [statusFilter, setStatusFilter] = useState<TriageStatus | 'all'>('open');
  const [channelFilter, setChannelFilter] = useState<string>('all');
  const [items, setItems] = useState<EngagementItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [patchError, setPatchError] = useState<string | null>(null);
  const [collectionStatus, setCollectionStatus] = useState<CollectionStatusItem[]>([]);
  const [members, setMembers] = useState<OrgMemberOption[]>([]);
  const [replyTargetId, setReplyTargetId] = useState<string | null>(null);
  const [convertTargetId, setConvertTargetId] = useState<string | null>(null);

  const loadPage = useCallback(async (cursor: string | null, replace: boolean) => {
    if (!orgId) return;
    if (replace) { setLoading(true); setLoadError(false); }
    try {
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (channelFilter !== 'all') params.set('channel', channelFilter);
      if (cursor) params.set('cursor', cursor);
      const res = await fetchWithAuth(`/api/organizations/${orgId}/engagement/items?${params.toString()}`);
      if (!res.ok) { setLoadError(true); return; }
      const data = await readJson<EngagementListResponse>(res);
      if (!data) { setLoadError(true); return; }
      setItems((prev) => (replace ? data.items : [...prev, ...data.items]));
      setHasMore(data.has_more);
      setNextCursor(data.next_cursor);
    } catch {
      setLoadError(true);
    } finally {
      if (replace) setLoading(false);
    }
  }, [orgId, statusFilter, channelFilter]);

  useEffect(() => { void loadPage(null, true); }, [loadPage]);

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    async function loadCollectionStatus() {
      try {
        const res = await fetchWithAuth(`/api/organizations/${orgId}/engagement/collection-status`);
        if (!res.ok || cancelled) return;
        const data = await readJson<{ connections: CollectionStatusItem[] }>(res);
        if (!cancelled && data) setCollectionStatus(data.connections);
      } catch {
        // story #3805 — 상단 배너는 보조 정보라 실패해도 목록 자체는 그대로 보인다
        // (조용히 생략, 별도 에러 배너 0 — 유나 §절6 밖 사고 방지).
      }
    }
    void loadCollectionStatus();
    return () => { cancelled = true; };
  }, [orgId]);

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    async function loadMembers() {
      try {
        const res = await fetchWithAuth(`/api/organizations/${orgId}/members`);
        if (!res.ok || cancelled) return;
        const data = await readJson<{ id: string; name: string }[]>(res);
        if (!cancelled && data) setMembers(data.map((m) => ({ id: m.id, name: m.name })));
      } catch {
        // 배정 드롭다운이 비어도 목록 자체는 정상 — fail-soft.
      }
    }
    void loadMembers();
    return () => { cancelled = true; };
  }, [orgId]);

  const channelOptions = useMemo(
    () => Array.from(new Set([...items.map((i) => i.channel), ...collectionStatus.map((c) => c.channel)])),
    [items, collectionStatus],
  );

  async function patchItem(id: string, body: { triage_status?: string; assignee_member_id?: string | null }) {
    setPatchError(null);
    const prev = items;
    setItems((current) => current.map((it) => (it.id === id ? { ...it, ...body } as EngagementItem : it)));
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgId}/engagement/items/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setItems(prev);
        setPatchError(t('engagementPatchFailed'));
        return;
      }
      const updated = await readJson<EngagementItem>(res);
      if (updated) setItems((current) => current.map((it) => (it.id === id ? updated : it)));
    } catch {
      setItems(prev);
      setPatchError(t('engagementPatchFailed'));
    }
  }

  function memberName(memberId: string | null): string | null {
    if (!memberId) return null;
    return members.find((m) => m.id === memberId)?.name ?? null;
  }

  function toCommentItem(item: EngagementItem): CommentItem {
    // 위 모듈 docstring 참고 — comments-section.tsx의 풍부한 계약을 이 큐가 아직
    // 모르는 필드는 "아직 모름" 기본값(fail-closed, 과대 표시 금지).
    return {
      id: item.id,
      authorDisplayName: item.author_display_name,
      bodyText: item.text,
      externalCreatedAt: null,
      capturedAt: item.captured_at,
      deletedAt: null,
      replyStatus: null,
      replyExternalUrl: null,
      replyFailureAction: undefined,
      replyCommandId: null,
      replyId: null,
      latestReplyText: null,
      repliesCount: 0,
      openReplyDraft: null,
      sentRepliesCount: 0,
    };
  }

  const replyTarget = items.find((i) => i.id === replyTargetId) ?? null;
  const convertTarget = items.find((i) => i.id === convertTargetId) ?? null;

  const openCountBadge = statusFilter === 'open' && !loading && !loadError
    ? t(hasMore ? 'engagementOpenCountAtLeast' : 'engagementOpenCountExact', { n: items.length })
    : null;

  const filtersActive = statusFilter !== 'open' || channelFilter !== 'all';

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <Tabs value="engagement" onValueChange={(v) => {
        if (v === 'list') router.push('/content/channel-posts');
        if (v === 'calendar') router.push('/content/channel-posts/calendar');
      }}
      >
        <TabsList data-testid="channel-posts-view-switch">
          <TabsTrigger value="list">{t('channelPostsViewList')}</TabsTrigger>
          <TabsTrigger value="calendar">{t('channelPostsViewCalendar')}</TabsTrigger>
          <TabsTrigger value="engagement" data-testid="channel-posts-engagement-tab">{t('channelPostsViewEngagement')}</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="flex items-center gap-3">
        <h1 className="font-heading text-lg font-medium text-foreground">{t('engagementPageTitle')}</h1>
        {openCountBadge ? (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
            {openCountBadge}
          </span>
        ) : null}
      </div>

      {collectionStatus.length > 0 ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" data-testid="engagement-collection-status">
          {collectionStatus.map((c) => (
            <span key={c.connection_id}>
              {c.last_collected_at
                ? t('engagementCollectionStatusCollected', {
                    channel: channelLabel(c.channel, t), time: formatRelativeTime(c.last_collected_at, locale, displayTimezone),
                  })
                : t('engagementCollectionStatusNotCollected', { channel: channelLabel(c.channel, t) })}
            </span>
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">{t('engagementFilterStatusLabel')}</span>
          <select
            className="rounded-md border border-border bg-background px-2 py-1 text-sm"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as TriageStatus | 'all')}
            data-testid="engagement-filter-status"
          >
            <option value="all">{t('engagementFilterStatusAll')}</option>
            {TRIAGE_STATUSES.map((s) => (
              <option key={s} value={s}>{t(STATUS_LABEL_KEY[s])}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">{t('engagementFilterChannelLabel')}</span>
          <select
            className="rounded-md border border-border bg-background px-2 py-1 text-sm"
            value={channelFilter}
            onChange={(e) => setChannelFilter(e.target.value)}
            data-testid="engagement-filter-channel"
          >
            <option value="all">{t('engagementFilterChannelAll')}</option>
            {channelOptions.map((c) => (
              <option key={c} value={c}>{channelLabel(c, t)}</option>
            ))}
          </select>
        </label>
      </div>

      {patchError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{patchError}</AlertDescription>
        </Alert>
      ) : null}

      {loadError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{t('engagementLoadFailed')}</AlertDescription>
        </Alert>
      ) : loading ? (
        <p className="text-sm text-muted-foreground">{t('channelPostsCalendarLoading')}</p>
      ) : items.length === 0 ? (
        filtersActive ? (
          <EmptyState
            title={t('engagementEmptyFilteredTitle')}
            action={(
              <Button variant="outline" onClick={() => { setStatusFilter('open'); setChannelFilter('all'); }}>
                {t('engagementClearFiltersCta')}
              </Button>
            )}
          />
        ) : (
          <EmptyState title={t('engagementEmptyTitle')} description={t('engagementEmptyDescription')} />
        )
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-b border-border bg-muted/40 text-xs font-medium text-muted-foreground">
              <tr>
                <th className="px-3 py-2">{t('engagementColumnChannel')}</th>
                <th className="px-3 py-2">{t('engagementColumnPreview')}</th>
                <th className="px-3 py-2">{t('engagementColumnCapturedAt')}</th>
                <th className="px-3 py-2">{t('engagementColumnStatus')}</th>
                <th className="px-3 py-2">{t('engagementColumnAssignee')}</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {items.map((item, index) => {
                const tone = STATUS_TONE[(item.triage_status as TriageStatus) in STATUS_TONE ? (item.triage_status as TriageStatus) : 'open'];
                const assignedName = memberName(item.assignee_member_id);
                // story #3592 회귀 가드(verify-repeated-row-action-names.ts) — 반복 행
                // 액션은 순번을 aria-label에 품긴다(comments-section.tsx와 동형 키 재사용).
                const ordinal = index + 1;
                return (
                  <tr key={item.id} className="border-b border-border last:border-0">
                    <td className="px-3 py-2 align-top">{channelLabel(item.channel, t)}</td>
                    <td className="max-w-xs px-3 py-2 align-top">
                      <p className="text-xs font-medium text-muted-foreground">
                        {item.author_display_name ?? t('originAuthorUnknown')}
                      </p>
                      <p className="line-clamp-2 whitespace-pre-wrap text-foreground">{item.text}</p>
                      {item.linked_story_id ? (
                        <a
                          href={getEntityHref('story', item.linked_story_id) ?? '#'}
                          className="mt-1 inline-block text-xs text-primary underline underline-offset-4"
                          data-testid="engagement-view-task-link"
                        >
                          {t('engagementViewTaskCta')}
                        </a>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 align-top text-muted-foreground">
                      {formatRelativeTime(item.captured_at, locale, displayTimezone)}
                    </td>
                    <td className="px-3 py-2 align-top">
                      <select
                        className={`inline-flex items-center gap-1.5 rounded-full border-0 px-2 py-0.5 text-xs font-medium ${tone.bg} ${tone.text}`}
                        value={item.triage_status}
                        onChange={(e) => void patchItem(item.id, { triage_status: e.target.value })}
                        data-testid="engagement-status-select"
                      >
                        {TRIAGE_STATUSES.map((s) => (
                          <option key={s} value={s}>{t(STATUS_LABEL_KEY[s])}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-3 py-2 align-top">
                      <select
                        className="rounded-md border border-border bg-background px-2 py-1 text-xs"
                        value={item.assignee_member_id ?? ''}
                        onChange={(e) => void patchItem(item.id, { assignee_member_id: e.target.value || null })}
                        data-testid="engagement-assignee-select"
                      >
                        <option value="">{t('engagementAssigneeNone')}</option>
                        {members.map((m) => (
                          <option key={m.id} value={m.id}>{m.name}</option>
                        ))}
                      </select>
                      {assignedName ? null : null}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 align-top text-right">
                      {item.linked_story_id ? null : (
                        <Button
                          variant="ghost" size="sm" onClick={() => setConvertTargetId(item.id)}
                          aria-label={t('commentsConvertToTaskAriaLabel', { n: ordinal, label: t('commentsConvertToTaskCta') })}
                        >
                          {t('commentsConvertToTaskCta')}
                        </Button>
                      )}
                      <Button
                        variant="ghost" size="sm" onClick={() => setReplyTargetId(item.id)}
                        aria-label={t('commentsReplyAriaLabel', { n: ordinal, label: t('commentsReplyCta') })}
                      >
                        {t('commentsReplyCta')}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {hasMore ? (
            <div className="flex justify-center border-t border-border p-3">
              <Button variant="outline" size="sm" onClick={() => void loadPage(nextCursor, false)}>
                {t('engagementLoadMoreCta')}
              </Button>
            </div>
          ) : null}
        </div>
      )}

      {replyTarget ? (
        <CommentReplyDialog
          comment={toCommentItem(replyTarget)}
          onClose={() => setReplyTargetId(null)}
          onCreateDraft={async (text): Promise<CommentReplyOutcome> => {
            const res = await fetchWithAuth(`/api/organizations/${orgId}/comments/${replyTarget.id}/replies`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text }),
            });
            if (!res.ok) {
              const errBody = (await res.json().catch(() => null)) as { error?: { message?: string; existing_reply_id?: string } } | null;
              return {
                ok: false,
                errorMessage: errBody?.error?.message ?? t('engagementPatchFailed'),
                existingReplyId: errBody?.error?.existing_reply_id,
              };
            }
            const data = (await res.json().catch(() => null)) as { data?: unknown } | null;
            if (!data?.data) return { ok: false, errorMessage: t('engagementPatchFailed') };
            return { ok: true, reply: data.data as CommentReplyOutcome extends { reply: infer R } ? R : never };
          }}
          onSubmit={async (replyId): Promise<CommentReplyOutcome> => {
            const res = await fetchWithAuth(`/api/organizations/${orgId}/comments/${replyTarget.id}/replies/${replyId}/submit`, {
              method: 'POST',
            });
            if (!res.ok) {
              const errBody = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
              return { ok: false, errorMessage: errBody?.error?.message ?? t('engagementPatchFailed') };
            }
            const data = (await res.json().catch(() => null)) as { data?: unknown } | null;
            if (!data?.data) return { ok: false, errorMessage: t('engagementPatchFailed') };
            return { ok: true, reply: data.data as CommentReplyOutcome extends { reply: infer R } ? R : never };
          }}
        />
      ) : null}

      {convertTarget ? (
        <CommentConvertToTaskDialog
          postTitle={channelLabel(convertTarget.channel, t)}
          comment={toCommentItem(convertTarget)}
          onClose={() => setConvertTargetId(null)}
          onSubmit={async ({ title, note }) => {
            const res = await fetchWithAuth(`/api/organizations/${orgId}/comments/${convertTarget.id}/follow-ups`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ title, note: note || null }),
            });
            const data = (await res.json().catch(() => null)) as { data?: { story_id?: string }; error?: { message?: string } } | null;
            if (res.ok && data?.data?.story_id) {
              const storyId = data.data.story_id;
              setItems((current) => current.map((it) => (it.id === convertTarget.id ? { ...it, linked_story_id: storyId } : it)));
              return { ok: true, storyId };
            }
            return { ok: false, errorMessage: data?.error?.message ?? t('engagementPatchFailed') };
          }}
        />
      ) : null}
    </div>
  );
}
