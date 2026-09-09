'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { MoreHorizontal } from 'lucide-react';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PageHeader } from '@/components/ui/page-header';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useToast } from '@/components/ui/toast';
import { fetchWithAuth } from '@/lib/db/client';
import { channelLabel } from '@/lib/channel-label';
import { resolveDisplayTimezone, formatScheduledAt } from '@/components/content/schedule-format';
import { deriveChannelPostView, type ChannelPublicationStatus } from '@/components/content/channel-post-status';
import { deriveFailureAction, type CommandStatus } from '@/components/content/failure-action';
import { FailureActionBadge } from '@/components/content/failure-action-badge';
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
 *
 * story #3744(UI 재설계 ①, 유나 시안 두 번째 판 — 미르코 2026-09-09) — content/page.tsx와
 * 동형 재설계. 열 5개(글·채널·나가는 시각·상태·⋯)로 축소 — 원작성 주체·글자 수·버전은
 * 「글」 칸의 부제/보조줄로 강등(삭제 아님, content/page.tsx와 동형 판단). 「채널 연결 0」
 * 빈 상태 갈래는 유나 코드 실측 정정(PO 채택) — 블로그는 connection_id=None이 hosted_site
 * 기본 목적지라 이 갈래가 없고, 채널 포스트만 create_channel_post_draft_version이
 * connection_id 필수라 실제로 「나갈 곳 없음」이 생긴다.
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
  scheduled_at?: string | null;
  text_preview?: string | null;
  text_length?: number | null;
  source_content_item_id?: string | null;
  source_title?: string | null;
  is_deleted?: boolean;
  can_archive?: boolean;
  // story #3744(유나 CHANGES⑤·PO 채택, 2026-09-09) — 목록 실패 표시를 FailureActionBadge
  // (channel-posts/[draftId]/page.tsx·failure-action-badge.tsx가 이미 쓰는 여섯 갈래
  // blocked/needs_check/auto_retry/dead_letter/voided/processing)로 통일한다. 계약
  // 필드는 ChannelPostDraftListItem(BE)에 이미 있다(story #3426 PR#3773 — command_status·
  // command_reason_code·failure_kind·next_retry_at·processing_kind, 신규 BE 0).
  command_status?: string | null;
  command_reason_code?: string | null;
  failure_kind?: string | null;
  next_retry_at?: string | null;
  processing_kind?: string | null;
}

interface ChannelConnectionStatusItem {
  id: string;
  status: string;
}

// content/page.tsx::toGateStatus와 동형.
function toGateStatus(status: string | null | undefined): ContentPostStatusInput['gateStatus'] {
  return status === 'pending' || status === 'approved' || status === 'rejected' ? status : undefined;
}

function realStr(v: string | null | undefined): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

type StatusTab = 'all' | 'draft' | 'pending' | 'approved' | 'published';

// content/page.tsx::toStatusTab과 동형 판단(그 파일 주석 참조 — 유나 CHANGES·PO 채택,
// 5탭·contentStatus* 라벨 재사용).
function toStatusTab(status: string | undefined): Exclude<StatusTab, 'all'> {
  if (status === 'pending' || status === 'reapproval_needed') return 'pending';
  if (status === 'approved') return 'approved';
  if (status === 'published') return 'published';
  return 'draft';
}

export default function ChannelPostListPage() {
  const { orgId } = useDashboardContext();
  const t = useTranslations('content');
  const tBoard = useTranslations('board');
  // story #3744(유나 CHANGES·PO 채택) — orgChannels는 nav 네임스페이스 키다(content가
  // 아니다). t('orgChannels')로 잘못 부르면 next-intl이 키를 못 찾아 원문 키 문자열이
  // 그대로 화면에 찍힌다 — 죽은 verify:i18n-key-existence(#3739가 그날 처분한 스크립트)가
  // 있었다면 이 클래스를 CI에서 잡았을 자리(#3739 PR 본문의 「값 실증」).
  const tNav = useTranslations('nav');
  const router = useRouter();
  const displayTimezone = resolveDisplayTimezone().tz;

  const [drafts, setDrafts] = useState<ChannelPostDraftListItem[]>([]);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [statusTab, setStatusTab] = useState<StatusTab>('all');
  // story #3744(PO 決) — 「채널 연결 0」 빈 상태 갈래 판별용. 활성(status==='active')
  // 연결 수만 센다 — expired/revoked/error는 화면에 채널 카드는 있어도 실제로 글을
  // 못 내보내니 "연결이 있다"로 치면 안 된다(유나 定 — 「연결 0」이 아니라 「활성
  // 연결 0」). 조회 자체가 안 됐으면(loading) 아직 판별 못 함 — 빈 상태/목록 둘 다
  // 안 그린다(PO 明示 — "모른다"로 잘못 그리지 않는다).
  const [connections, setConnections] = useState<ChannelConnectionStatusItem[] | null>(null);
  const { addToast } = useToast();

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    async function loadConnections() {
      try {
        const res = await fetchWithAuth(`/api/organizations/${orgId}/channel-connections`);
        if (cancelled) return;
        if (res.ok) {
          const json = (await res.json().catch(() => null)) as { data?: ChannelConnectionStatusItem[] } | null;
          setConnections(json?.data ?? []);
        }
      } catch {
        // 조회 실패는 연결 0으로 단정하지 않는다 — connections는 null로 남아 그
        // 갈래를 그리지 않는다(fail-closed, 지어내지 않음).
      }
    }
    void loadConnections();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      setLoadError(false);
      try {
        // story #3734(카디르 CI 적발) — content/page.tsx(site-posts)와 동형(그 파일 주석
        // 참조 — content-bff-route-coverage.guard.test.ts #3445가 `?`를 템플릿 밖에 두면
        // 세그먼트를 못 읽는다).
        const qs = showArchived ? 'include_deleted=true' : '';
        const res = await fetchWithAuth(`/api/organizations/${orgId}/channel-posts/drafts?${qs}`);
        if (cancelled) return;
        if (res.ok) {
          const json = (await res.json().catch(() => null)) as
            | { data?: ChannelPostDraftListItem[]; meta?: { total?: number | null } | null }
            | null;
          setDrafts(json?.data ?? []);
          setTotalCount(json?.meta?.total ?? null);
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
  }, [orgId, showArchived]);

  // story #3734 — content/page.tsx(site-posts)의 handleArchiveToggle과 동형(그 파일
  // 주석 참조 — include_deleted=true 뷰는 "포함"이지 "전용"이 아니라 그 안에서는 행을
  // 안 뺀다, 기본 뷰에서 방금 보관된 경우만 뺀다).
  const handleArchiveToggle = async (draft: ChannelPostDraftListItem) => {
    if (!orgId || archivingId) return;
    setArchivingId(draft.draft_id);
    try {
      const res = draft.is_deleted
        ? await fetchWithAuth(`/api/organizations/${orgId}/channel-posts/drafts/${draft.draft_id}/restore`, { method: 'POST' })
        : await fetchWithAuth(`/api/organizations/${orgId}/channel-posts/drafts/${draft.draft_id}/archive`, { method: 'POST' });
      if (!res.ok) return;
      const json = (await res.json().catch(() => null)) as { data?: { is_deleted: boolean } } | null;
      const isDeleted = json?.data?.is_deleted ?? !draft.is_deleted;
      setDrafts((prev) => {
        if (!showArchived && isDeleted) return prev.filter((d) => d.draft_id !== draft.draft_id);
        return prev.map((d) => (d.draft_id === draft.draft_id ? { ...d, is_deleted: isDeleted } : d));
      });
      if (isDeleted) {
        addToast({
          title: t('archivedToast'),
          action: showArchived ? undefined : { label: t('showArchivedToggle'), onClick: () => setShowArchived(true) },
        });
      }
    } finally {
      setArchivingId(null);
    }
  };

  const draftsWithStatus = useMemo(
    () => drafts.map((draft) => {
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
      // story #3744(유나 CHANGES⑤) — deriveFailureAction이 command_status를 최우선으로
      // 본다(voided/dead_letter/blocked는 failure_kind를 안 본다) — publicationStatus
      // 파생(publicationFailed)과 별개 축. 예: 재시도가 processing이면 publicationFailed는
      // 여전히 true(publication_status가 안 바뀌었으므로)지만 failureAction은 undefined가
      // 되거나 processing 갈래로 갈려, 목록·상세가 다른 판을 그리던 §17-15 어긋남이 닫힌다.
      const failureAction = deriveFailureAction({
        commandStatus: (draft.command_status ?? null) as CommandStatus | null,
        failureKind: draft.failure_kind,
        nextRetryAt: draft.next_retry_at,
        reasonCode: draft.command_reason_code,
        processingKind: draft.processing_kind,
      });
      return { draft, view, failureAction, tab: toStatusTab(view.status) };
    }),
    [drafts],
  );

  const visibleRows = statusTab === 'all'
    ? draftsWithStatus
    : draftsWithStatus.filter((row) => row.tab === statusTab);

  const shownCount = drafts.length;
  const activeConnectionCount = connections?.filter((c) => c.status === 'active').length ?? null;
  const hasNoChannels = activeConnectionCount === 0;

  const connectChannelAction = (
    <Button asChild variant="hero">
      <Link href="/organization/channels">{tNav('orgChannels')}</Link>
    </Button>
  );

  // story #3744(페드루 CHANGES Ⓑ, 시안 v6) — 채널 프레임도 블로그와 같은 「대화 열기」
  // primary(openChatCta, content/page.tsx의 chatAction과 동형) — 「View calendar」
  // outline은 header 주 액션 자리가 아니라 탭 줄 위 목록/캘린더 세그먼트로 내려간다
  // (시안 "차이는 열 셋과 뷰 전환뿐").
  const chatAction = (
    <Button asChild variant="hero">
      <Link href="/chats">{t('openChatCta')}</Link>
    </Button>
  );

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <PageHeader
        title={t('channelPostsTitle')}
        description={t('channelPostsDescription')}
        actions={chatAction}
      />

      {/* story #3744(페드루 CHANGES Ⓑ) — 목록/캘린더 뷰 전환. stock Tabs 재사용(새 세그먼트
          컴포넌트 발명 0) — 「목록」은 이 화면 자신(no-op)이고 「캘린더」 선택은 그 route로
          이동한다(캘린더는 별도 페이지라 탭 패널 전환이 아니라 네비게이션). */}
      <Tabs value="list" onValueChange={(v) => { if (v === 'calendar') router.push('/content/channel-posts/calendar'); }}>
        <TabsList data-testid="channel-posts-view-switch">
          <TabsTrigger value="list">{t('channelPostsViewList')}</TabsTrigger>
          <TabsTrigger value="calendar" data-testid="channel-posts-calendar-link">{t('channelPostsViewCalendar')}</TabsTrigger>
        </TabsList>
      </Tabs>


      {connections !== null && !hasNoChannels ? (
        <div className="flex items-center justify-between gap-4">
          <Tabs value={statusTab} onValueChange={(v) => setStatusTab(v as StatusTab)}>
            <TabsList data-testid="channel-posts-status-tabs">
              <TabsTrigger value="all">{t('statusTabAll')}</TabsTrigger>
              <TabsTrigger value="draft">{t('contentStatusDraft')}</TabsTrigger>
              <TabsTrigger value="pending">{t('contentStatusPending')}</TabsTrigger>
              <TabsTrigger value="approved">{t('contentStatusApproved')}</TabsTrigger>
              <TabsTrigger value="published">{t('contentStatusPublished')}</TabsTrigger>
            </TabsList>
          </Tabs>
          <Button
            type="button"
            variant="link"
            onClick={() => setShowArchived((v) => !v)}
            className="h-auto min-h-0 min-w-0 shrink-0 px-0 text-sm font-normal text-foreground underline"
            data-testid="channel-posts-show-archived-toggle"
          >
            {showArchived ? t('hideArchivedToggle') : t('showArchivedToggle')}
          </Button>
        </div>
      ) : null}

      {loadError ? (
        <Alert variant="destructive" role="alert" aria-live="assertive" aria-atomic="true">
          <AlertDescription>{t('channelPostsLoadFailed')}</AlertDescription>
        </Alert>
      ) : null}

      {connections === null ? (
        // story #3744(PO 明示) — 연결 조회가 아직 안 끝났으면 「연결 0」과 「목록」
        // 어느 쪽도 그리지 않는다(모른다≠0건).
        <div className="space-y-3" data-testid="channel-posts-connections-loading">
          {[1, 2].map((i) => <div key={i} className="h-12 animate-pulse rounded-md bg-muted" />)}
        </div>
      ) : hasNoChannels ? (
        <EmptyState
          title={t('channelPostsNoChannelsTitle')}
          description={t('channelPostsNoChannelsListDescription')}
          action={connectChannelAction}
        />
      ) : loading ? (
        <div className="space-y-3" data-testid="channel-posts-list-loading">
          {[1, 2, 3].map((i) => <div key={i} className="h-12 animate-pulse rounded-md bg-muted" />)}
        </div>
      ) : visibleRows.length === 0 ? (
        !loadError ? (
          // story #3744(유나 CHANGES·PO 채택) — content/page.tsx와 동형(그 파일 주석
          // 참조) — 탭이 「전체」가 아닌데 0건이면 statusTabEmpty로.
          statusTab !== 'all' ? (
            <EmptyState title={t('statusTabEmpty')} />
          ) : (
            <EmptyState
              title={showArchived ? t('archivedEmpty') : t('channelPostsEmptyTitle')}
              description={showArchived ? undefined : t('channelPostsEmptyDescription')}
            />
          )
        ) : null
      ) : (
        <Card className="overflow-hidden p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">{t('channelPostsColumnPreview')}</th>
                <th className="px-3 py-2 text-left font-medium">{t('channelPostsColumnChannel')}</th>
                <th className="px-3 py-2 text-left font-medium">{t('channelPostsColumnOutgoingAt')}</th>
                <th className="px-3 py-2 text-left font-medium">{t('channelPostsColumnStatus')}</th>
                {/* story #3736 ⑤-보강 — 액션 열 머리는 sr-only(content/page.tsx와 동형). */}
                <th className="px-3 py-2 text-left font-medium">
                  <span className="sr-only">{t('columnActionsSrLabel')}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {visibleRows.map(({ draft, view, failureAction, tab }, index) => {
                const hasTextPreview = 'text_preview' in draft && draft.text_preview != null;
                const scheduled = realStr(draft.scheduled_at);
                return (
                  <tr key={draft.draft_id} data-testid="channel-posts-list-row">
                    <td className="max-w-xs px-3 py-2.5 font-medium text-foreground">
                      <Link href={`/content/channel-posts/${draft.draft_id}`} className="truncate hover:underline">
                        {hasTextPreview
                          ? draft.text_preview
                          : `${channelLabel(draft.channel, t)} · v${draft.current_version}`}
                      </Link>
                      {/* story #3744(페드루 CHANGES Ⓒ, 시안 v6) — 버전·글자 수 부제는
                          시안에 없다("v1 · 12"처럼 분모 이름 없는 수는 오히려 읽는 사람을
                          더 헷갈리게 한다는 실측 지적) — 상세 화면의 일이라 걷는다(삭제
                          아님, 이 화면에서만 안 그린다). 시안 부제는 «작성자»뿐이라
                          origin-author 배지만 남긴다. */}
                      {draft.origin_author_kind && draft.origin_author_kind !== draft.latest_author_kind ? (
                        <div className="mt-0.5" data-testid="channel-post-origin-author">
                          <AuthorKindBadge kind={draft.origin_author_kind} />
                        </div>
                      ) : null}
                      {view.partialSuccess ? (
                        <span
                          className="mt-1 inline-flex rounded-full bg-warning-tint px-1.5 py-0.5 text-xs text-foreground"
                          data-testid="channel-post-partial-success"
                        >
                          {t('channelPostsPartialSuccess')}
                        </span>
                      ) : null}
                      {draft.source_content_item_id && draft.source_title ? (
                        <p className="mt-0.5 truncate text-xs text-muted-foreground" data-testid="channel-post-source-link">
                          {t('channelPostsSourceLabel')}{' '}
                          <Link href={`/content/${draft.source_content_item_id}`} className="underline">
                            {t('channelPostsSourceLinkText', { title: draft.source_title })}
                          </Link>
                        </p>
                      ) : null}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
                        {channelLabel(draft.channel, t)}
                        {isSandboxChannelDraft(draft.channel) ? <SandboxTestBadge /> : null}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground">
                      {/* story #3744(유나 픽셀 CHANGES①·PO 채택, 2026-09-09 12:33Z) —
                          「나가는 시각」 칸이 「언제 나가나」의 답을 전부 쥔다. 기존
                          `scheduled ? format : '—'` 한 줄이 세 뜻(예약 없음/발행됨/막힘)을
                          「—」 하나로 뭉갰다 — 「—」는 이제 "아직 예약 없음" 한 뜻만.
                          우선순위: 막힘(FailureActionBadge, 상시 답이 필요한 다음 발) >
                          발행됨(published_at, 계약에 이미 있음) > 예약(scheduled_at) >
                          「—」. compact — 재시도 버튼은 상세로(페드루 정정, 2026-09-09
                          14:01Z 3746 — 「채널에서 확인했습니다」 체크+중복 경고가 2단계
                          액션이라 목록 행에서 시작 못 한다). */}
                      {failureAction ? (
                        <FailureActionBadge action={failureAction} displayTimezone={displayTimezone} compact />
                      ) : draft.published_at ? (
                        formatScheduledAt(draft.published_at, displayTimezone).display
                      ) : scheduled ? (
                        formatScheduledAt(scheduled, displayTimezone).display
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      {draft.is_deleted ? (
                        <span
                          className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-foreground"
                          data-testid="channel-post-archived-badge"
                        >
                          {t('contentStatusArchived')}
                        </span>
                      ) : (
                        <StatusChip status={view.status} />
                      )}
                      {/* story #3744(페드루 CHANGES Ⓒ, 시안 v6) — 상태 칩 밑 상대 시각
                          부제는 시안에 없다. 걷는다(삭제 아님 — 상세 화면의 일). */}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center justify-end gap-1.5">
                        {/* story #3744(페드루 CHANGES Ⓐ, 시안 v6) — content/page.tsx와
                            동형(그 파일 주석 참조 — 「상태 딱지는 사람을 멈춰 세우고 다음
                            발은 움직인다·숨긴 액션은 터치에선 없는 것」). ⋯ 메뉴엔 이제
                            보관/보관 해제만 남는다(같은 동작을 두 자리에 안 둔다). */}
                        {tab === 'pending' ? (
                          <Button
                            variant="outline" size="sm" onClick={() => router.push('/inbox?tab=gates')}
                            // story #3592(§22-18 "유나의 자") — 상시 노출 행 액션이라
                            // archiveRowAriaLabel(순번+현재 라벨) 재사용, content/page.tsx와 동형.
                            aria-label={t('archiveRowAriaLabel', { n: index + 1, label: t('approvalRequestViewCta') })}
                          >
                            {t('approvalRequestViewCta')}
                          </Button>
                        ) : null}
                        {/* story #3744(PO 決, 시안 v4 14e399df) — 발행됨 행 다음 발
                            「채널에서 보기」(content.commentsReplyExternalLinkCta 재사용
                            — content/page.tsx의 「발행된 글 보기」와 다른 낱말, 블로그는
                            자사 사이트·채널은 외부 플랫폼이라 구별). permalink는 기존
                            계약 필드 재사용(신규 BE 0) — public_url과 동형 규율: 없으면
                            버튼 자체를 안 그린다. */}
                        {tab === 'published' && draft.permalink ? (
                          <Button
                            variant="outline" size="sm"
                            onClick={() => window.open(draft.permalink!, '_blank', 'noopener,noreferrer')}
                            aria-label={t('archiveRowAriaLabel', { n: index + 1, label: t('commentsReplyExternalLinkCta') })}
                          >
                            {t('commentsReplyExternalLinkCta')}
                          </Button>
                        ) : null}
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                            data-testid="channel-post-row-actions-trigger"
                            aria-label={t('rowActionsAriaLabel', { n: index + 1 })}
                          >
                            <MoreHorizontal className="size-4" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {draft.can_archive ? (
                              <DropdownMenuItem
                                onClick={() => void handleArchiveToggle(draft)}
                                disabled={archivingId === draft.draft_id}
                                data-testid="channel-post-archive-action"
                                aria-label={t('archiveRowAriaLabel', {
                                  n: index + 1,
                                  label: draft.is_deleted ? t('unarchiveAction') : t('archiveAction'),
                                })}
                              >
                                {draft.is_deleted ? t('unarchiveAction') : t('archiveAction')}
                              </DropdownMenuItem>
                            ) : null}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      {/* story #3744(유나 CHANGES·PO 채택) — content/page.tsx와 동형(그 파일 주석 참조 —
          statusTab이 'all'이 아니면 shownCount≠visibleRows 표시 개수라 이 줄을 안 그린다). */}
      {!loading && !hasNoChannels && statusTab === 'all' && totalCount !== null && shownCount > 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="channel-posts-partial-state">
          {tBoard('tasksPartialCount', { loaded: shownCount, total: totalCount })}
        </p>
      ) : null}
    </div>
  );
}
