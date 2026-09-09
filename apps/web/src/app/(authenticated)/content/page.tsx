'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
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
 */

interface SitePostDraftListItem {
  draft_id: string;
  work_item_id: string;
  slug: string;
  lang: string;
  title: string;
  current_version: number;
  latest_author_kind: 'agent' | 'human';
  // story #3368 §6-3-1(유나 실측, 페드루 PO 확定 2026-09-03) — latest_author_kind 하나만
  // 보이면 "에이전트가 쓰고 사람이 고친 글"과 "사람이 처음부터 쓴 글"이 목록에서
  // 똑같이 human으로 보인다. 원작성 주체(1번 버전의 author_kind)를 별도 열로 분리한다
  // — 디디군 S2 PR에 이 필드를 목록 항목에 얹으라 지시됨. 도착 前(지금)엔 옵셔널이라
  // undefined — fail-closed로 "—"만 보인다(지어내지 않음).
  origin_author_kind?: 'agent' | 'human' | null;
  updated_at: string;
  gate_status?: string | null;
  reapproval_required?: boolean | null;
  sealed_content_sha256?: string | null;
  body_sha256: string;
  published_at?: string | null;
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


export default function ContentPostListPage() {
  const { orgId } = useDashboardContext();
  const t = useTranslations('content');
  const locale = useLocale();
  const displayTimezone = resolveDisplayTimezone().tz;

  const [drafts, setDrafts] = useState<SitePostDraftListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  // story #3734 — 「보관됨 보기」 토글. 기본 false(목록에서 보관된 초안 기본 제외).
  const [showArchived, setShowArchived] = useState(false);
  const [archivingId, setArchivingId] = useState<string | null>(null);
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
          const json = (await res.json().catch(() => null)) as { data?: SitePostDraftListItem[] } | null;
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

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold text-foreground">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('description')}</p>
        </div>
        {/* story #3734 — 「보관됨 보기」 토글(유나 定: 두 상태 문구 다 정함).
            story #3739(카디르 CI 적발, verify-no-new-raw-button.ts #3164) — raw
            button 태그를 Button으로. 페드루 CHANGES(2026-09-09, PR#4084) — 최초
            variant="ghost"+hover:bg-transparent 보정(story #3177/#3183/#3215
            선례)은 dark:hover:bg-muted/50이 별도 클래스라 안 지워져 다크 hover에
            배경이 남는 회귀였다(유나 실측). 정본 = variant="link"(hover 배경 자체가
            없어 지울 것이 없음)+색만 text-foreground로 덮기 — text-primary는
            twMerge가 지우고 hover:underline은 상시 밑줄이라 무해. 두 번째 CHANGES
            (유나 재확認) — link 변형 전환이 hover:underline만 주고 rest 밑줄은
            안 준다는 점을 놓쳐 className의 명시 underline까지 같이 걷혀 rest 밑줄이
            사라졌던 회귀도 정정(className 끝에 underline 유지). */}
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
      ) : drafts.length === 0 ? (
        !loadError ? (
          <EmptyState
            title={showArchived ? t('archivedEmpty') : t('emptyTitle')}
            description={showArchived ? undefined : t('emptyDescription')}
          />
        ) : null
      ) : (
        <div className="overflow-hidden rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">{t('columnTitle')}</th>
                <th className="px-3 py-2 text-left font-medium">{t('columnStatus')}</th>
                <th className="px-3 py-2 text-left font-medium">{t('columnVersion')}</th>
                <th className="px-3 py-2 text-left font-medium">{t('columnOriginAuthor')}</th>
                <th className="px-3 py-2 text-left font-medium">{t('columnAuthor')}</th>
                <th className="px-3 py-2 text-left font-medium">{t('columnUpdatedAt')}</th>
                <th className="px-3 py-2 text-left font-medium">{t('columnActions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {drafts.map((draft, index) => {
                // 페드루 PO 리뷰(2026-09-03) — `draft.published_at != null`은 값이 null이든
                // 키 자체가 없든(구 백엔드·응답 결손) 똑같이 false가 되어 "발행 안 됐다"로
                // 단정한다. `'published_at' in draft`로 키 존재를 먼저 물어 키가 없으면
                // undefined(모른다)를 넘긴다 — deriveContentPostStatus의 AC6 분기가 이걸
                // 받아 status를 비운다(§3-1-1 "모른다≠다르다", AC4).
                //
                // gate_status는 그 축의 "모른다" 신호를 deriveContentPostStatus 자체가
                // 표현하지 못한다(게이트 부재=draft와 게이트 신호 결손=모른다를 함수 안에서
                // 구별할 방법이 없다) — 그래서 그 판단은 여기서 앞서 가로챈다: 계약 필드
                // (gate_status) 자체가 없으면 파생을 아예 부르지 않고 행 전체를 판별
                // 불가(undefined)로 둔다.
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
                return (
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
                    <td className="px-3 py-2.5 text-muted-foreground">v{draft.current_version}</td>
                    <td className="px-3 py-2.5" data-testid="content-origin-author">
                      <AuthorKindBadge kind={draft.origin_author_kind} />
                    </td>
                    <td className="px-3 py-2.5" data-testid="content-latest-author">
                      <AuthorKindBadge kind={draft.latest_author_kind} />
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground">
                      {formatRelativeTime(draft.updated_at, locale, displayTimezone)}
                    </td>
                    <td className="px-3 py-2.5">
                      {/* story #3734 — can_archive 하나만 본다(FE는 role 비교 안 함,
                          can_withdraw와 동형 정책). 확認 없음(유나 定 — 되돌릴 수 있는
                          소프트 액션). */}
                      {draft.can_archive ? (
                        <Button
                          type="button"
                          variant="link"
                          onClick={() => void handleArchiveToggle(draft)}
                          disabled={archivingId === draft.draft_id}
                          className="h-auto min-h-0 min-w-0 px-0 text-sm font-normal text-foreground underline disabled:opacity-50"
                          data-testid="content-archive-action"
                          // story #3734(카디르 CI 적발) — 정적 라벨(「보관」/「보관 해제」)이
                          // 행마다 똑같아 verify-no-new-repeated-row-action-names(§22-18
                          // "유나의 자") 위반. 순번+보이는 라벨을 aria-label에 품는다(이웃
                          // channelRowActionAriaLabel·orgMemberRowActionAriaLabel과 동형).
                          // story #3739(카디르 CI 적발, verify-no-new-raw-button.ts #3164) —
                          // raw button 태그를 Button으로(위 토글과 동형 보정, 페드루
                          // CHANGES 반영 — variant="link"가 정본, ghost 아님, underline 유지).
                          aria-label={t('archiveRowAriaLabel', {
                            n: index + 1,
                            label: draft.is_deleted ? t('unarchiveAction') : t('archiveAction'),
                          })}
                        >
                          {draft.is_deleted ? t('unarchiveAction') : t('archiveAction')}
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
