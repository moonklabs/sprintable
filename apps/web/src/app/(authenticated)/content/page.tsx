'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
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
import { ToastContainer, useToast } from '@/components/ui/toast';
import { fetchWithAuth } from '@/lib/db/client';
import { formatRelativeTime } from '@/lib/storage/format';
import { resolveDisplayTimezone } from '@/components/content/schedule-format';
import { deriveContentPostStatus, type ContentPostStatusInput } from '@/components/content/post-status';
import { StatusChip } from '@/components/content/status-chip';
import { AuthorKindBadge } from '@/components/content/author-kind-badge';

/**
 * story #3368(Phase0·마케팅운영 S4, doc phase0-post-manager-screen-design §8-1 순서 2번) —
 * 글 목록(와이어프레임 S1·S2). site-posts drafts는 org 스코프(프로젝트 무관)라
 * organization/connectors/page.tsx와 동형으로 useDashboardContext()의 orgId 하나만
 * 갖고 그린다(project 슬러그 불필요).
 *
 * story #3384(Phase0 결함, 유나 원인 진단·페드루 PO 확定 2026-09-03) — 목록 상태 칩이
 * 게이트·발행 신호와 무관하게 항상 "초안"으로만 뜨던 결함(deriveContentPostStatus({})를
 * 빈 입력으로 호출)의 근본 수정. 목록 응답이 이제 상세 계약(story #3386)과 같은 필드명
 * (gate_status·reapproval_required·sealed_content_sha256·body_sha256·published_at)을
 * 배치로 실어온다 — 행마다 별도 조회 없음(N+1 금지, list_site_post_drafts() 참조).
 *
 * story #3744(UI 재설계 ①, 유나 시안 두 번째 판 — 미르코 2026-09-09) — 「관리자 덤프
 * 표」를 사람이 읽는 판으로. PageHeader(제목+설명+주 액션 「대화 열기」) · 상태 탭 ·
 * 열 4(제목·상태·마지막 수정·⋯) · 행 ⋯ 메뉴 · 부분 상태 줄 · Card 표 래퍼.
 */

interface SitePostDraftListItem {
  draft_id: string;
  work_item_id: string;
  slug: string;
  lang: string;
  title: string;
  current_version: number;
  latest_author_kind: 'agent' | 'human';
  origin_author_kind?: 'agent' | 'human' | null;
  updated_at: string;
  gate_status?: string | null;
  reapproval_required?: boolean | null;
  sealed_content_sha256?: string | null;
  body_sha256: string;
  published_at?: string | null;
  // story #3744(PO 決 2026-09-09) — 「발행됨」 행의 다음 발 「발행된 글 보기」용
  // (content.publishViewLink 재사용, [draftId]/page.tsx:1629와 같은 낱말). 없으면(미발행
  // 또는 public_site_base_url 미설정) 그 액션 자체를 안 그린다 — "—"도 안 쓴다(PO 明示).
  public_url?: string | null;
  // story #3734 — 「보관」 배지·행 액션. can_archive는 서버가 (원저자 또는 org owner/
  // admin) 판정을 전부 마쳐 낸 bool 하나 — FE는 role 비교를 직접 안 한다(can_withdraw와
  // 동형 정책). 둘 다 키 부재 시 fail-closed(false) — "모른다=버튼 안 보임".
  is_deleted?: boolean;
  can_archive?: boolean;
}

// content/[draftId]/page.tsx::toGateStatus와 동형 — external_publish는 휴먼 승인만
// 인정(auto_passed 도달 불가), pending/approved/rejected 밖은 "유효한 승인 대상 없음"과
// 동형으로 undefined 처리해 deriveContentPostStatus가 'draft'로 안전하게 떨어지게 한다.
function toGateStatus(status: string | null | undefined): ContentPostStatusInput['gateStatus'] {
  return status === 'pending' || status === 'approved' || status === 'rejected' ? status : undefined;
}

function realStr(v: string | null | undefined): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

type StatusTab = 'all' | 'draft' | 'pending' | 'approved' | 'published';

// story #3744(유나 CHANGES·PO 채택, 2026-09-09) — 미르코의 최초 4탭 접기(승인됨→발행됨
// 합침)를 정정: 「발행됨」 탭이 approved(=아직 사람이 「발행」을 안 누른 발행 가능 일감)를
// 품으면 그 탭이 행의 실제 칩(「승인됨」)을 부정하는 꼴이 된다. 정본 = 5탭 전체/초안/승인
// 대기/승인됨/발행됨, 탭 라벨은 contentStatus* 칩 키를 그대로 재사용(새 낱말 0). 「승인
// 대기」는 reapproval_needed를 계속 포함(그 상태도 사람의 승인 조치가 필요하다는 점은
// 동일). 상태를 판별 불가(undefined)면 '초안' 탭에 둔다(가장 보수적인 위치).
function toStatusTab(status: string | undefined): Exclude<StatusTab, 'all'> {
  if (status === 'pending' || status === 'reapproval_needed') return 'pending';
  if (status === 'approved') return 'approved';
  if (status === 'published') return 'published';
  return 'draft';
}

export default function ContentPostListPage() {
  const { orgId } = useDashboardContext();
  const t = useTranslations('content');
  // story #3744(페드루 스티어 2026-09-09) — 부분 상태 문구는 board.tasksPartialCount
  // (「{total}개 중 {loaded}개 표시 중」, story-detail-panel.tsx 선례)를 재사용한다.
  // 새 키를 안 만드는 이유 — 같은 문구를 두 namespace에 중복 등록하면 나중에 한쪽만
  // 고쳐 드리프트(verify-no-i18n-phrase-collision류 클래스와 사촌).
  const tBoard = useTranslations('board');
  const locale = useLocale();
  const router = useRouter();
  const displayTimezone = resolveDisplayTimezone().tz;

  const [drafts, setDrafts] = useState<SitePostDraftListItem[]>([]);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  // story #3734 — 「보관됨 보기」 토글. 기본 false(목록에서 보관된 초안 기본 제외).
  const [showArchived, setShowArchived] = useState(false);
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [statusTab, setStatusTab] = useState<StatusTab>('all');
  const { toasts, addToast, dismissToast } = useToast();

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      setLoadError(false);
      try {
        // story #3734(카디르 CI 적발, content-bff-route-coverage.guard.test.ts #3445) —
        // 가드는 fetchWithAuth 템플릿을 `?` «앞»에서 잘라 세그먼트로 쪼갠다. `?`가 템플릿
        // 밖(qs 변수)에 있으면 세그먼트가 `drafts${qs}`(리터럴+보간 혼합)가 돼 디렉터리를
        // 못 찾는다 — `?`를 템플릿 안에 둔다(qs는 앞 `?` 없이).
        const qs = showArchived ? 'include_deleted=true' : '';
        const res = await fetchWithAuth(`/api/organizations/${orgId}/site-posts/drafts?${qs}`);
        if (cancelled) return;
        if (res.ok) {
          const json = (await res.json().catch(() => null)) as
            | { data?: SitePostDraftListItem[]; meta?: { total?: number | null } | null }
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

  // story #3734 — 보관/보관 해제는 확認 없이 즉시 실행(되돌리기가 쉬운 소프트 액션이라
  // withdraw류 파괴적 액션의 ConfirmDialog 관례를 안 따른다, 유나 定). 성공 시 로컬
  // 목록에서 낙관적으로 갱신한다 — `include_deleted=true`(showArchived)는 "보관된
  // 것만"이 아니라 "보관된 것도 포함"이라는 뜻(BE 쿼리 파라미터 이름 그대로)이라, 그
  // 뷰에서는 보관하든 해제하든 행이 계속 보여야 한다(배지·버튼만 뒤집는다). 행을 아예
  // 빼는 경우는 오직 하나 — 기본(showArchived=false) 뷰에서 방금 보관해 그 뷰의 필터
  // 조건(미보관만)을 어긴 경우.
  const handleArchiveToggle = async (draft: SitePostDraftListItem) => {
    if (!orgId || archivingId) return;
    setArchivingId(draft.draft_id);
    try {
      // story #3734(카디르 CI 적발) — content-bff-route-coverage.guard.test.ts(#3445)는
      // `fetchWithAuth` 호출식 «안»의 리터럴 URL만 스캔한다(변수에 담아 부르면 눈에서
      // 사라져 "안 잰 것"이 된다). archive/restore는 디렉터리 자체가 다른 리터럴이라
      // 변수(`action`)로 합칠 수 없다 — 호출을 둘로 분기한다(그래야 가드가 프록시
      // 누락 클래스를 실제로 재는 자리가 된다).
      const res = draft.is_deleted
        ? await fetchWithAuth(`/api/organizations/${orgId}/site-posts/drafts/${draft.draft_id}/restore`, { method: 'POST' })
        : await fetchWithAuth(`/api/organizations/${orgId}/site-posts/drafts/${draft.draft_id}/archive`, { method: 'POST' });
      if (!res.ok) return;
      const json = (await res.json().catch(() => null)) as { data?: { is_deleted: boolean } } | null;
      const isDeleted = json?.data?.is_deleted ?? !draft.is_deleted;
      setDrafts((prev) => {
        if (!showArchived && isDeleted) return prev.filter((d) => d.draft_id !== draft.draft_id);
        return prev.map((d) => (d.draft_id === draft.draft_id ? { ...d, is_deleted: isDeleted } : d));
      });
      // story #3734(유나 CHANGES) — 보관 직후 행이 그냥 사라지면 「삭제」로 읽힌다(데이터
      // 이름이 is_deleted라 더욱). 「어디로 갔는지」 토스트 + 「보관됨 보기」 액션(기존
      // 토글 낱말 재사용) — 보관 해제는 이미 화면에 남아 있는 상태의 되돌리기라 안 띄운다.
      // PO 추가(08:12Z) — 액션은 !showArchived일 때만 붙인다. 이미 「보관됨 보기」가
      // 켜진 화면에서 그 액션은 "지금 있는 곳으로 가라"가 된다(컨트롤은 그려진 순간
      // "할 수 있다"를 약속하는 자리 — 이미 그 상태인데 누르라고 하면 안 됨).
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

  // story #3744 — 행마다 다섯 상태 파생을 미리 계산해 둔다(탭 필터·상태 칩·다음 발
  // 버튼이 전부 이 값을 공유 — 세 곳에서 따로 파생하면 서로 다른 값을 낼 드리프트
  // 표면이 생긴다).
  const draftsWithStatus = useMemo(
    () => drafts.map((draft) => {
      const hasGateContract = 'gate_status' in draft;
      const { status } = hasGateContract
        ? deriveContentPostStatus({
            gateStatus: toGateStatus(draft.gate_status),
            reapprovalRequired: draft.reapproval_required ?? undefined,
            sealedBodySha256: realStr(draft.sealed_content_sha256),
            currentBodySha256: draft.body_sha256,
            hasPublishedSitePost: 'published_at' in draft ? draft.published_at != null : undefined,
          })
        : { status: undefined };
      return { draft, status, tab: toStatusTab(status) };
    }),
    [drafts],
  );

  const visibleRows = statusTab === 'all'
    ? draftsWithStatus
    : draftsWithStatus.filter((row) => row.tab === statusTab);

  const shownCount = drafts.length;

  const chatAction = (
    <Button asChild variant="hero">
      <Link href="/chats">{t('openChatCta')}</Link>
    </Button>
  );

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={chatAction}
      />

      <div className="flex items-center justify-between gap-4">
        <Tabs value={statusTab} onValueChange={(v) => setStatusTab(v as StatusTab)}>
          <TabsList>
            <TabsTrigger value="all">{t('statusTabAll')}</TabsTrigger>
            <TabsTrigger value="draft">{t('contentStatusDraft')}</TabsTrigger>
            <TabsTrigger value="pending">{t('contentStatusPending')}</TabsTrigger>
            <TabsTrigger value="approved">{t('contentStatusApproved')}</TabsTrigger>
            <TabsTrigger value="published">{t('contentStatusPublished')}</TabsTrigger>
          </TabsList>
        </Tabs>
        {/* story #3734 — 「보관됨 보기」 토글(유나 定: 두 상태 문구 다 정함).
            story #3744(페드루 CHANGES 2026-09-09, PR#4084 낱말 정정 반영) — variant="ghost"+
            hover:bg-transparent는 dark:hover:bg-muted/50이 별도 클래스라 안 지워져 다크
            hover에 배경이 남는다(유나 실측). 정본 = variant="link"(hover 배경 자체가
            없음)+색만 text-foreground로 덮기. 44px 터치 바닥은 이 h-auto 보정이 버리는
            축이라 별건 적기만(페드루 지적, 3744 재편 스코프 — 이 파일은 임시 텍스트
            링크 형이고 시안 실 배선 때 진짜 버튼/토글 컴포넌트로 교체된다). */}
        <Button
          type="button"
          variant="link"
          onClick={() => setShowArchived((v) => !v)}
          className="h-auto min-h-0 min-w-0 shrink-0 px-0 text-sm font-normal text-foreground underline"
          data-testid="content-show-archived-toggle"
        >
          {showArchived ? t('hideArchivedToggle') : t('showArchivedToggle')}
        </Button>
      </div>

      {loadError ? (
        <Alert variant="destructive" role="alert" aria-live="assertive" aria-atomic="true">
          <AlertDescription>{t('loadFailed')}</AlertDescription>
        </Alert>
      ) : null}

      {loading ? (
        <div className="space-y-3" data-testid="content-list-loading">
          {[1, 2, 3].map((i) => <div key={i} className="h-12 animate-pulse rounded-md bg-muted" />)}
        </div>
      ) : visibleRows.length === 0 ? (
        !loadError ? (
          // story #3744(유나 CHANGES·PO 채택) — 탭이 「전체」가 아닌데 그 탭에 걸리는 행이
          // 0이면(전체는 안 비었을 수 있다) "아직 초안이 없습니다"는 거짓 진술이 된다 —
          // statusTabEmpty(설명·주 액션 없음, 탭을 바꾸라는 뜻 하나만)로 분기. 탭이
          // 「전체」일 때만 기존 archivedEmpty/emptyTitle 분기로 내려간다.
          statusTab !== 'all' ? (
            <EmptyState title={t('statusTabEmpty')} />
          ) : (
            <EmptyState
              title={showArchived ? t('archivedEmpty') : t('emptyTitle')}
              description={showArchived ? undefined : t('emptyDescription')}
              action={showArchived ? undefined : chatAction}
            />
          )
        ) : null
      ) : (
        <Card className="overflow-hidden p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">{t('columnTitle')}</th>
                <th className="px-3 py-2 text-left font-medium">{t('columnStatus')}</th>
                <th className="px-3 py-2 text-left font-medium">{t('columnLastModified')}</th>
                {/* story #3736 ⑤-보강 — 액션 열 머리는 빈 문자열(시각)이지만 sr-only로
                    구조적 이름을 남긴다(스크린리더가 "이름 없는 열"로 읽지 않도록). */}
                <th className="px-3 py-2 text-left font-medium">
                  <span className="sr-only">{t('columnActionsSrLabel')}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {visibleRows.map(({ draft, status, tab }, index) => (
                <tr key={draft.draft_id} data-testid="content-list-row">
                  <td className="px-3 py-2.5 font-medium text-foreground">
                    <Link href={`/content/${draft.draft_id}`} className="hover:underline">
                      {draft.title}
                    </Link>
                  </td>
                  <td className="px-3 py-2.5">
                    {/* story #3734 — 보관된 행은 발행/게이트 파생 상태 대신 「보관됨」
                        배지 하나(유나 §짝확認 — 「보관」 액션이 서면 상태 배지는
                        「보관됨」이어야 한다). 파생 상태 자체는 무변(재보관 해제 시
                        그대로 복귀). */}
                    {draft.is_deleted ? (
                      <span
                        className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-foreground"
                        data-testid="content-archived-badge"
                      >
                        {t('contentStatusArchived')}
                      </span>
                    ) : (
                      <StatusChip status={status} />
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <p className="text-muted-foreground">{formatRelativeTime(draft.updated_at, locale, displayTimezone)}</p>
                    {/* story #3744 — 열 축소(§6-3-1의 원작성 주체 열 삭제 아님, 하위
                        칸으로 강등). 원작성·최종수정이 갈리는 실제 케이스(에이전트가
                        쓰고 사람이 고침)를 목록에서 계속 구별하려면 두 칩이 다 있어야
                        한다 — origin_author_kind가 latest_author_kind와 같을 땐 반복
                        정보라 origin 칩을 생략한다(같은 이름 두 번은 소음). */}
                    <div className="mt-0.5 flex flex-wrap items-center gap-1" data-testid="content-latest-author">
                      <AuthorKindBadge kind={draft.latest_author_kind} />
                    </div>
                    {draft.origin_author_kind !== draft.latest_author_kind ? (
                      <div className="mt-0.5 text-xs" data-testid="content-origin-author" title={t('columnOriginAuthor')}>
                        <AuthorKindBadge kind={draft.origin_author_kind} />
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center justify-end gap-1.5">
                      {/* story #3744(페드루 CHANGES Ⓐ, 시안 v6) — 「상태 딱지는 사람을
                          멈춰 세우고 다음 발은 움직인다·숨긴 액션은 터치에선 없는 것」.
                          ⋯ 메뉴 뒤에 숨기지 않고 상시 보이는 outline 버튼으로(상태 뒤·⋯
                          앞). 같은 동작을 두 자리에 두지 않는다 — ⋯ 메뉴엔 이제 보관/
                          보관 해제만 남는다. */}
                      {tab === 'pending' ? (
                        <Button
                          variant="outline" size="sm" onClick={() => router.push('/inbox?tab=gates')}
                          // story #3592(§22-18 "유나의 자") — 이 버튼도 이제 상시 노출
                          // 행 액션이라 archiveRowAriaLabel과 동형(순번+현재 라벨) 재사용.
                          aria-label={t('archiveRowAriaLabel', { n: index + 1, label: t('approvalRequestViewCta') })}
                        >
                          {t('approvalRequestViewCta')}
                        </Button>
                      ) : null}
                      {/* story #3744(PO 決) — public_url이 없으면(미발행 또는
                          public_site_base_url 미설정) 버튼 자체를 안 그린다 — "—"도 안
                          쓴다(비활성이 아니라 부재). */}
                      {tab === 'published' && draft.public_url ? (
                        <Button
                          variant="outline" size="sm"
                          onClick={() => window.open(draft.public_url!, '_blank', 'noopener,noreferrer')}
                          aria-label={t('archiveRowAriaLabel', { n: index + 1, label: t('publishViewLink') })}
                        >
                          {t('publishViewLink')}
                        </Button>
                      ) : null}
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                          data-testid="content-row-actions-trigger"
                          // story #3592(§22-18 "유나의 자") — 행마다 다른 접근 이름(순번
                          // 품음). 이 트리거는 정적 라벨(⋯)뿐이라 값이 갈리지 않으면 이
                          // 가드의 관할 밖 클래스로 다시 샌다 — 미리 순번을 품는다.
                          aria-label={t('rowActionsAriaLabel', { n: index + 1 })}
                        >
                          <MoreHorizontal className="size-4" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {draft.can_archive ? (
                            <DropdownMenuItem
                              onClick={() => void handleArchiveToggle(draft)}
                              disabled={archivingId === draft.draft_id}
                              data-testid="content-archive-action"
                            >
                              {draft.is_deleted ? t('unarchiveAction') : t('archiveAction')}
                            </DropdownMenuItem>
                          ) : null}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {/* story #3744 범위 ⑥ — 「N개 중 M개 표시 중」. totalCount가 null이면(헤더를
          못 받음) 그 자리 전체를 안 그린다 — "이 페이지 수"를 "전체"로 위장하지 않는다
          (한 페이지로 전체 단정 금지 클래스). 페이지네이션(「더 보기」 클릭 시 다음
          페이지 로드)은 이 스토리 범위 밖(적기만 — limit 기본 50이 지금 규모 대비
          충분히 넉넉해 실사용 hasMore가 거의 안 걸린다, 표시만 먼저 닫는다).
          story #3744(유나 CHANGES·PO 채택) — shownCount(=drafts.length, 필터 前 서버
          응답 개수)와 totalCount는 서버가 낸 같은 축의 두 수다. 하지만 표는 visibleRows
          (탭으로 클라이언트 필터 後)를 그린다 — statusTab이 'all'이 아니면 shownCount≠표에
          실제로 보이는 행 수라 「18개 중 18개」식 거짓 문장이 된다(서버가 탭별 count를
          안 준다). totalCount===null 규율과 동형으로 statusTab==='all'일 때만 그린다. */}
      {!loading && statusTab === 'all' && totalCount !== null && shownCount > 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="content-partial-state">
          {tBoard('tasksPartialCount', { loaded: shownCount, total: totalCount })}
        </p>
      ) : null}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
