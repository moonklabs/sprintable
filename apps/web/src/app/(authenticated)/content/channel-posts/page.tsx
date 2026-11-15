'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useChatsHref, useConnectRulesHref, useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { Chip, Tag } from '@/components/ds/chip';
import { DataText } from '@/components/ds/data-text';
import { EmptyState } from '@/components/ds/empty-state';
import { PageFrame } from '@/components/ds/page-frame';
import { PageHead } from '@/components/ds/page-head';
import { RowList, RowListItem, type RowAction } from '@/components/ds/row-list';
import { Skeleton } from '@/components/ds/skeleton';
import { TabNav, TabNavLink } from '@/components/ds/tab-nav';
import { Tabs, TabsList, TabsTrigger } from '@/components/ds/tabs';
import { useToast } from '@/components/ds/toast';
import { OrgScreenTitle } from '@/components/organization/org-screen-title';
import { fetchWithAuth } from '@/lib/db/client';
import { useChannelLabel } from '@/lib/channel-label';
import { formatViewerScheduledAt, formatScheduledAt } from '@/lib/schedule-format';
import { deriveChannelPostView, type ChannelPublicationStatus } from '@/components/content/channel-post-status';
import { deriveFailureAction, type CommandStatus } from '@/components/content/failure-action';
import { FailureActionBadge } from '@/components/content/failure-action-badge';
import { type ContentPostStatus, type ContentPostStatusInput, contentPostStatusLabelKey } from '@/components/content/post-status';
import { isSandboxChannelDraft, SandboxTestBadge } from '@/components/content/sandbox-test-badge';
import { useFlatHref } from '@/hooks/use-flat-href';
import { useViewerTimeZone } from '@/components/viewer-time-zone';
import { useTeamTimeZone } from '@/components/team-time-zone';

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
 *
 * 4913(UI-R5 D물결) — 블로그 포스트(content/page.tsx)와 같은 «한 쪽 틀»로: 제목은 위 막대 · 본문은 PageFrame wide · 머리 = 설명 + «대화 열기» · 목록/캘린더/반응 전환 = TabNav(진짜 링크) ·
 * 상태 탭 + «보관됨 보기» · 표 → RowList(한 줄 = 본문 미리보기 + 상태 칩 + 부제(채널 · 나가는 시각) + 다음 발 단추 · 행 아래 작은 글 = 막힘 사유 · 부분 성공 · 같은 스토리의 글).
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
  // story #3815(배포 82 라이브 회차 실 결함) — command_reason_code==='YOUTUBE_QUOTA_
  // EXCEEDED'일 때만 채워진다.
  command_reason_reset_at?: string | null;
  /** story #4290(까디르 QA ④) — 서버 한 판정: 보는 사람이 지금 이 명령을 «다시 시도»할 수 있는가(`viewer_can_retry`). */
  command_retryable?: boolean;
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
  const teamTz = useTeamTimeZone(); // story #4443 PR3b — a promised time is the team's (the org's zone)
  const flatHref = useFlatHref(); // story #4231 — flat 링크 `?p=`
  const { orgId } = useDashboardContext();
  // story #4017(PO 확定 2026-09-17) — 아래 대화 CTA(/chats)를 목적지 모듈로.
  const chatsHref = useChatsHref();
  // story #4017 — 아래 「채널 연결」 CTA(/organization/channels)를 목적지 모듈로.
  const connectRulesHref = useConnectRulesHref('/organization/channels');
  const t = useTranslations('content');
  const channelLabel = useChannelLabel();
  const tBoard = useTranslations('board');
  // story #3744(유나 CHANGES·PO 채택) — orgChannels는 nav 네임스페이스 키다(content가
  // 아니다). t('orgChannels')로 잘못 부르면 next-intl이 키를 못 찾아 원문 키 문자열이
  // 그대로 화면에 찍힌다 — 죽은 verify:i18n-key-existence(#3739가 그날 처분한 스크립트)가
  // 있었다면 이 클래스를 CI에서 잡았을 자리(#3739 PR 본문의 「값 실증」).
  const tNav = useTranslations('nav');
  const tCommon = useTranslations('common');
  const router = useRouter();
  const displayTimezone = useViewerTimeZone(); // story #4443 PR2b — the viewer's zone (null until known)

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
            | { data?: ChannelPostDraftListItem[]; meta?: { totalCount?: number | null } | null }
            | null;
          setDrafts(json?.data ?? []);
          setTotalCount(json?.meta?.totalCount ?? null);
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
        reasonResetAt: draft.command_reason_reset_at,
        processingKind: draft.processing_kind,
        // story #4290(까디르 QA ④) — 목록도 서버 한 판정을 싣는다(카드는 버튼이 없지만 같은 값으로 가른다).
        retryable: draft.command_retryable ?? null,
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
    <Button asChild variant="primary">
      <Link href={connectRulesHref}>{tNav('orgChannels')}</Link>
    </Button>
  );

  // story #3744(페드루 CHANGES Ⓑ, 시안 v6) — 채널 프레임도 블로그와 같은 「대화 열기」 primary(openChatCta, content/page.tsx의 chatAction과 동형).
  const chatAction = (
    <Button asChild variant="primary">
      <Link href={chatsHref}>{t('openChatCta')}</Link>
    </Button>
  );

  const renderRow = ({ draft, view, failureAction, tab }: (typeof draftsWithStatus)[number], index: number) => {
    const detailHref = flatHref(`/content/channel-posts/${draft.draft_id}`);
    const hasTextPreview = 'text_preview' in draft && draft.text_preview != null;
    const scheduled = realStr(draft.scheduled_at);
    const actions: RowAction[] = draft.can_archive
      ? [{ key: 'archive', label: draft.is_deleted ? t('unarchiveAction') : t('archiveAction'), disabled: archivingId === draft.draft_id, onSelect: () => void handleArchiveToggle(draft) }]
      : [];
    // 나가는 시각(story #3744 ① 우선순위 4단): 막힘(FailureActionBadge) > 발행 시각 > 예약 시각 > «—». 막힘은 한 줄에 안 들어가는 문장이라 행 아래 작은 글로, 나머지는 부제에.
    const outgoingText = draft.published_at
      ? formatViewerScheduledAt(draft.published_at, displayTimezone).display
      : scheduled
        ? formatScheduledAt(scheduled, teamTz, displayTimezone).display
        : '—';
    const originDiffers = draft.origin_author_kind && draft.origin_author_kind !== draft.latest_author_kind;
    const hasSource = !!(draft.source_content_item_id && draft.source_title);
    const footnote = failureAction || view.partialSuccess || hasSource ? (
      <>
        {failureAction ? (
          <div data-testid="channel-post-outgoing-at">
            <FailureActionBadge
              action={failureAction} displayTimezone={displayTimezone} compact
              approvalContext={(('gate_status' in draft && 'scheduled_at' in draft)
                ? { gateStatus: draft.gate_status ?? null, sealedScheduledAt: draft.scheduled_at ?? null } : undefined)}
            />
          </div>
        ) : null}
        {view.partialSuccess ? (
          <div><Chip tone="needs-hand" data-testid="channel-post-partial-success">{t('channelPostsPartialSuccess')}</Chip></div>
        ) : null}
        {hasSource && draft.source_title ? (
          // flex: 링크 상자가 줄 안에 머물고(`min-w-0 truncate`) 긴 원본 제목은 말줄임 — 인라인 <a>를 truncate 문단에 두면 글은 잘려도 링크 상자가 패널 밖까지 뻗는다(레이아웃 e2e가 잡음, 510 > 375).
          <p className="m-0 flex min-w-0 gap-1" data-testid="channel-post-source-link">
            <span className="shrink-0">{t('channelPostsSourceLabel')}</span>{' '}
            <Link href={flatHref(`/content/${draft.source_content_item_id}`)} className="min-w-0 truncate underline">
              {t('channelPostsSourceLinkText', { title: draft.source_title })}
            </Link>
          </p>
        ) : null}
      </>
    ) : undefined;
    return (
      <RowListItem
        key={draft.draft_id}
        data-testid="channel-posts-list-row"
        title={(
          <Link href={detailHref} className="block truncate hover:underline">
            {hasTextPreview ? draft.text_preview : `${channelLabel(draft.channel)} · v${draft.current_version}`}
          </Link>
        )}
        subtitle={(
          <>
            <span>{channelLabel(draft.channel)}</span>
            {isSandboxChannelDraft(draft.channel) ? <>{' '}<SandboxTestBadge /></> : null}
            {failureAction ? null : <>{' · '}<DataText data-testid="channel-post-outgoing-at">{outgoingText}</DataText></>}
            {originDiffers ? <>{' '}<span data-testid="channel-post-origin-author"><AuthorTag kind={draft.origin_author_kind} /></span></> : null}
          </>
        )}
        statusMark={draft.is_deleted ? <Chip data-testid="channel-post-archived-badge">{t('contentStatusArchived')}</Chip> : <StatusMark status={view.status} />}
        trailing={(
          <>
            {tab === 'pending' ? (
              <Button
                variant="secondary" onClick={() => router.push(flatHref('/inbox?tab=gates'))}
                aria-label={t('archiveRowAriaLabel', { n: index + 1, label: t('approvalRequestViewCta') })}
              >
                {t('approvalRequestViewCta')}
              </Button>
            ) : null}
            {tab === 'published' && draft.permalink ? (
              <Button
                variant="secondary" onClick={() => window.open(draft.permalink!, '_blank', 'noopener,noreferrer')}
                aria-label={t('archiveRowAriaLabel', { n: index + 1, label: t('commentsReplyExternalLinkCta') })}
              >
                {t('commentsReplyExternalLinkCta')}
              </Button>
            ) : null}
          </>
        )}
        actions={actions}
        actionsLabel={t('rowActionsAriaLabel', { n: index + 1 })}
        footnote={footnote}
        onOpen={() => router.push(detailHref)}
      />
    );
  };

  return (
    <>
      <OrgScreenTitle>{t('channelPostsTitle')}</OrgScreenTitle>
      <PageFrame width="wide">
        <PageHead description={t('channelPostsDescription')} actions={chatAction} />

        {/* story #3744(페드루 CHANGES Ⓑ) — 목록/캘린더/반응 전환. 「목록」은 이 화면 자신이고 「캘린더」·「반응」은 별도 페이지라 탭 패널이 아니라 «진짜 링크»(TabNav — 새 창으로도 열린다).
            story #3805(PR 2[FE], 유나 §절1) — 「반응」 세 번째. 새 사이드바 항목 0. */}
        <TabNav aria-label={t('channelPostsTitle')} data-testid="channel-posts-view-switch">
          <TabNavLink active aria-current="page" href={flatHref('/content/channel-posts')}>{t('channelPostsViewList')}</TabNavLink>
          <TabNavLink asChild>
            <Link href={flatHref('/content/channel-posts/calendar')} data-testid="channel-posts-calendar-link">{t('channelPostsViewCalendar')}</Link>
          </TabNavLink>
          <TabNavLink asChild>
            <Link href={flatHref('/content/channel-posts/engagement')} data-testid="channel-posts-engagement-link">{t('channelPostsViewEngagement')}</Link>
          </TabNavLink>
        </TabNav>

        {/* story #4277 — 콘텐츠 목록과 같은 줄(상태 탭 + «보관됨 보기») — 좁은 폭 · 긴 로케일에서 토글이 다음 줄로. 탭 뿌리는 min-w-0 max-w-full — 탭 줄이 틀 안에서 스스로 가로 스크롤(블로그 포스트가 CI에서 겪은 넘침과 같은 자리). */}
        {connections !== null && !hasNoChannels ? (
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <Tabs value={statusTab} onValueChange={(v) => setStatusTab(v as StatusTab)} className="min-w-0 max-w-full">
              <TabsList data-testid="channel-posts-status-tabs" aria-label={t('channelPostsTitle')}>
                <TabsTrigger value="all">{t('statusTabAll')}</TabsTrigger>
                <TabsTrigger value="draft">{t('contentStatusDraft')}</TabsTrigger>
                <TabsTrigger value="pending">{t('contentStatusPending')}</TabsTrigger>
                <TabsTrigger value="approved">{t('contentStatusApproved')}</TabsTrigger>
                <TabsTrigger value="published">{t('contentStatusPublished')}</TabsTrigger>
              </TabsList>
            </Tabs>
            <Button
              type="button"
              variant="quiet"
              onClick={() => setShowArchived((v) => !v)}
              aria-pressed={showArchived}
              data-testid="channel-posts-show-archived-toggle"
            >
              {showArchived ? t('hideArchivedToggle') : t('showArchivedToggle')}
            </Button>
          </div>
        ) : null}

        {loadError ? <Banner tone="failed" announce="assertive">{t('channelPostsLoadFailed')}</Banner> : null}

        {connections === null ? (
          // story #3744(PO 明示) — 연결 조회가 아직 안 끝났으면 「연결 0」과 「목록」 어느 쪽도 그리지 않는다(모른다≠0건).
          <div role="status" aria-busy="true" className="space-y-3" data-testid="channel-posts-connections-loading">
            <span className="sr-only">{tCommon('loading')}</span>
            {[1, 2].map((i) => <Skeleton key={i} className="h-14 w-full" />)}
          </div>
        ) : hasNoChannels ? (
          <EmptyState
            title={t('channelPostsNoChannelsTitle')}
            description={t('channelPostsNoChannelsListDescription')}
            action={connectChannelAction}
          />
        ) : loading ? (
          <div role="status" aria-busy="true" className="space-y-3" data-testid="channel-posts-list-loading">
            <span className="sr-only">{tCommon('loading')}</span>
            {[1, 2, 3].map((i) => <Skeleton key={i} className="h-14 w-full" />)}
          </div>
        ) : visibleRows.length === 0 ? (
          !loadError ? (
            // story #3744(유나 CHANGES·PO 채택) — content/page.tsx와 동형 — 탭이 「전체」가 아닌데 0건이면 statusTabEmpty로.
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
          <RowList aria-label={t('channelPostsTitle')} data-testid="channel-posts-list">
            {visibleRows.map((row, index) => renderRow(row, index))}
          </RowList>
        )}

        {/* story #3744(유나 CHANGES·PO 채택) — content/page.tsx와 동형(statusTab이 'all'이 아니면 shownCount≠visibleRows 표시 개수라 이 줄을 안 그린다). */}
        {!loading && !hasNoChannels && statusTab === 'all' && totalCount !== null && shownCount > 0 ? (
          <p className="m-0 text-ds-small text-ds-ink-3" data-testid="channel-posts-partial-state">
            {tBoard('tasksPartialCount', { loaded: shownCount, total: totalCount })}
          </p>
        ) : null}
      </PageFrame>
    </>
  );
}

// 4913 — 상태 칩: 블로그 포스트(content/page.tsx)와 같은 «뜻 → 색» 짝(옛 StatusChip의 `data-status-chip`을 e2e 측정 헬퍼가 읽는다). 판별 불가(undefined)는 색 칩 아닌 평문 «—».
const STATUS_TONE: Record<ContentPostStatus, 'neutral' | 'needs-hand' | 'info' | 'done' | 'failed'> = {
  draft: 'neutral', pending: 'needs-hand', approved: 'info', published: 'done', reapproval_needed: 'failed',
};

function StatusMark({ status }: { status: ContentPostStatus | undefined }) {
  const t = useTranslations('content');
  if (status === undefined) return <span className="text-ds-small text-ds-ink-3">{t('originAuthorUnknown')}</span>;
  return <Chip tone={STATUS_TONE[status]} dot data-status-chip={status}>{t(contentPostStatusLabelKey(status))}</Chip>;
}

// 4913 — 작성 주체 꼬리표(원작성이 최종 수정과 다를 때): 블로그 포스트와 같은 낱말 · «모르면 —».
function AuthorTag({ kind }: { kind: 'agent' | 'human' | null | undefined }) {
  const t = useTranslations('content');
  if (kind !== 'agent' && kind !== 'human') return <span>{t('originAuthorUnknown')}</span>;
  return <Tag>{kind === 'agent' ? t('authorAgent') : t('authorHuman')}</Tag>;
}
