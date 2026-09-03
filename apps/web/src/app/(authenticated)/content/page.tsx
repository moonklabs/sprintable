'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { EmptyState } from '@/components/ui/empty-state';
import { fetchWithAuth } from '@/lib/db/client';
import { deriveContentPostStatus } from '@/components/content/post-status';
import { StatusChip } from '@/components/content/status-chip';

/**
 * story #3368(Phase0·마케팅운영 S4, doc phase0-post-manager-screen-design §8-1 순서 2번) —
 * 글 목록(와이어프레임 S1·S2). site-posts drafts는 org 스코프(프로젝트 무관)라
 * organization/connectors/page.tsx와 동형으로 useDashboardContext()의 orgId 하나만
 * 갖고 그린다(project 슬러그 불필요).
 *
 * ⚠️오늘 시점(S1 목록 계약만 착지, S2 봉인 해시·S3 공개 projection 전) — 목록 응답에
 * 게이트·해시·발행 신호가 아직 없어 모든 행이 deriveContentPostStatus({})→'draft'로만
 * 파생된다. §8-1 4·6번(승인 카드 확장·재승인 화면)은 그 신호가 착지한 뒤 이 화면에
 * 상태 열을 마저 채운다 — 파생 로직 자체(post-status.ts)는 이미 다섯 상태 전부 정의돼
 * 있어 여기서 다시 손댈 필요가 없다.
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
                const { status } = deriveContentPostStatus({});
                return (
                  <tr key={draft.draft_id} data-testid="content-list-row">
                    <td className="px-3 py-2.5 font-medium text-foreground">
                      <Link href={`/content/${draft.draft_id}`} className="hover:underline">
                        {draft.title}
                      </Link>
                    </td>
                    <td className="px-3 py-2.5"><StatusChip status={status} /></td>
                    <td className="px-3 py-2.5 text-muted-foreground">v{draft.current_version}</td>
                    <td className="px-3 py-2.5 text-muted-foreground" data-testid="content-origin-author">
                      {draft.origin_author_kind === 'agent'
                        ? t('authorAgent')
                        : draft.origin_author_kind === 'human'
                          ? t('authorHuman')
                          : t('originAuthorUnknown')}
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground">
                      {draft.latest_author_kind === 'agent' ? t('authorAgent') : t('authorHuman')}
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
