'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { EmptyState } from '@/components/ui/empty-state';
import { fetchWithAuth } from '@/lib/db/client';
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

  const [drafts, setDrafts] = useState<SitePostDraftListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      setLoadError(false);
      try {
        const res = await fetchWithAuth(`/api/organizations/${orgId}/site-posts/drafts`);
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
  }, [orgId]);

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold text-foreground">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
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
        !loadError ? <EmptyState title={t('emptyTitle')} description={t('emptyDescription')} /> : null
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
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {drafts.map((draft) => {
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
                    <td className="px-3 py-2.5"><StatusChip status={status} /></td>
                    <td className="px-3 py-2.5 text-muted-foreground">v{draft.current_version}</td>
                    <td className="px-3 py-2.5" data-testid="content-origin-author">
                      <AuthorKindBadge kind={draft.origin_author_kind} />
                    </td>
                    <td className="px-3 py-2.5" data-testid="content-latest-author">
                      <AuthorKindBadge kind={draft.latest_author_kind} />
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground">
                      {new Date(draft.updated_at).toLocaleString()}
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
