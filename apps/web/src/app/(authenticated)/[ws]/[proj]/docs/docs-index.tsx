'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ds/button';
import { IconButton } from '@/components/ds/icon-button';
import { Icon } from '@/components/ds/icon';
import { Card } from '@/components/ds/card';
import { EmptyState } from '@/components/ds/empty-state';
import { ListRow } from '@/components/ds/list-row';
import { DocStatusChip } from '@/components/docs/doc-status-chip';
import { useDocsLayout, type Doc } from './docs-context';
import { docUrl } from '@/components/docs/lib/doc-project-url';
import { toDocStatusFilter, type DocStatusFilter } from '@/components/docs/lib/doc-status-tone';
import { formatViewerRelativeTime } from '@/lib/storage/format';
import { useViewerTimeZone } from '@/components/viewer-time-zone';

/**
 * story #2955 §2/§6(doc docs-index-reader-redesign-handoff) — 셸 A "지식 인덱스". 미선택
 * 상태(옛 `DocsEmptyView`의 "문서를 선택하세요" 죽은 화면)를 대체한다 — 라우트 추가 없이
 * `page.tsx`가 이 컴포넌트를 직접 렌더(§6 계약: 미선택=인덱스, 신규 라우트 불요).
 *
 * PO 그라운딩 확定(2026-08-23) — 시안 원안의 236px "색인 레일"은 기존 공유 좌측 네비
 * (`docs-client-layout.tsx`: 검색·태그·정렬·드래그재정렬 딸린 실 탐색 수단, 리더/에디터
 * 화면에서도 상시 노출)를 대체하는 게 아니다. 그 공유 네비의 교체는 더 큰 구조 변경이라
 * 이번 스토리(2 셸) 스코프 밖으로 판정됐다 — 레일이 갖고 있던 카테고리·상태별 정보는
 * 이 컴포넌트의 «본문 헤더 존» 필터로 자리만 옮겨 실현한다(정보는 보존, 배치만 변경).
 *
 * 카테고리 출처 = top-level 폴더(`is_folder && parent_id===null`, 스펙 §2 결정) — 신규 BE
 * 필드 0. 카운트는 이 뷰가 이미 들고 있는(`useDocsLayout().tree`) 로드된 집합 기준 —
 * 사이드바 트리와 동일 페이지네이션(더 보기)을 공유하므로 "더 보기"로 늘어나면 카운트도
 * 같이 늘어난다(별도 전량 소진 fetch를 새로 만들지 않음 — 대부분 프로젝트는 첫 페이지 안에
 * 다 들어오고, 안 들어와도 사이드바와 같은 정직한 "지금까지 로드된 것" 기준이라 두 표면이
 * 어긋나지 않는다).
 */

// story #2963 — 색 매핑을 doc-status-tone.ts 공유 모듈로 이관(값 무변경, #2963 레일 v2가
// "1호 인덱스 StatusChip과 같은 doc.status 소스"로 재사용하기 위함). 이 파일 로컬 타입은
// alias만 유지.
type StatusFilter = DocStatusFilter;
const STATUS_FILTERS: StatusFilter[] = ['confirmed', 'pending', 'denied', 'draft'];
const UNCATEGORIZED = '__uncategorized__';

export function DocsIndex() {
  const t = useTranslations('docs');
  const tc = useTranslations('common');
  const locale = useLocale();
  const displayTimezone = useViewerTimeZone(); // story #4443 PR2b — the viewer's zone (null until known)
  const router = useRouter();
  const { tree, handleNewDoc, wsSlug, projSlug, loading, loadError, fetchTree } = useDocsLayout();
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null); // null = 전체
  const [statusFilter, setStatusFilter] = useState<StatusFilter | null>(null);
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');

  const folders = useMemo(
    () => tree.filter((d) => d.is_folder && d.parent_id === null),
    [tree],
  );
  const items = useMemo(() => tree.filter((d) => !d.is_folder), [tree]);

  const categoryOf = (doc: Doc): string => {
    if (!doc.parent_id) return UNCATEGORIZED;
    const parent = folders.find((f) => f.id === doc.parent_id);
    return parent ? parent.id : UNCATEGORIZED; // 폴더-안-폴더 등 깊은 중첩은 미분류로 낙하(§2 단순화, 문서화된 판단).
  };

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = { [UNCATEGORIZED]: 0 };
    for (const f of folders) counts[f.id] = 0;
    for (const item of items) counts[categoryOf(item)] = (counts[categoryOf(item)] ?? 0) + 1;
    return counts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, folders]);

  const statusCounts = useMemo(() => {
    const counts: Record<StatusFilter, number> = { confirmed: 0, pending: 0, denied: 0, draft: 0 };
    for (const item of items) counts[toDocStatusFilter(item.status)] += 1;
    return counts;
  }, [items]);

  const filtered = useMemo(() => {
    return items
      .filter((item) => (categoryFilter === null ? true : categoryOf(item) === categoryFilter))
      .filter((item) => (statusFilter === null ? true : toDocStatusFilter(item.status) === statusFilter))
      .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, categoryFilter, statusFilter]);

  // story #2967(선생님 실사용 판정) — 인덱스 클릭이 리더(docViewUrl)로 가면 트리 사이드바
  // (에디터 직행)와 목적지가 갈려 편집까지 2스텝(인덱스→리더→편집)이 됐다. 트리와 동선을
  // 통일해 에디터 직행 1스텝으로 되돌린다 — 리더는 에디터 상단의 opt-in "읽기 보기" 링크로만
  // 진입(삭제 아님, default만 이동).
  // story 4892 (UI-9 D1, PO 11-10) reverses the #2967 judgement above: a document opened from the index now opens to READ (people open documents to read);
  // «고치기» in the detail header is the way into the editor.
  const goToDoc = (slug: string) => router.push(`${docUrl(wsSlug, projSlug, slug)}/view`);

  // story #3784 — "아직 안 옴"·"실패"·"정말 0건"을 가른다. 로딩 中엔 조용히 아무것도
  // 그리지 않는다(사이드바가 이미 로딩 중 신호를 그린다 — 이 존까지 스켈레톤을 겹칠 이유 0).
  // story #3946(유나 확認·페드루 정정) — 시각은 그대로 아무것도 안 그리되, docs-client-
  // layout.tsx의 TopBarSlot이 비-헤딩(<p>)이라 이 로딩 순간엔 페이지 전체에 h1이 0개가
  // 된다("페이지 h1 항상 정확히 1개" 불변식 gap). sr-only h1로만 메운다(시각 무변).
  if (loading) {
    return <h1 className="sr-only">{t('title')}</h1>;
  }

  if (loadError) {
    // story #3784(유나 정정 09:40Z) — 0건 분기와 같은 형(early return + 빈 페인 중앙). story 4892: ds EmptyState + ds Button, 알림 역할(role=alert)은 그대로.
    return (
      <div className="flex h-full items-center justify-center p-4 lg:p-6">
        <div role="alert" aria-live="assertive" aria-atomic="true">
          <EmptyState
            icon="error"
            title={t('indexLoadError')}
            action={<Button variant="secondary" onClick={() => void fetchTree()}>{tc('retry')}</Button>}
          />
        </div>
      </div>
    );
  }

  // story #2955 §6(PO 요건②) — "문서를 선택하세요" 재현 금지. 0건은 에러가 아니라 만들 데이터로서 설계 — 첫 문서 CTA + 왜 0인지 맥락(신규 프로젝트) 병기.
  if (tree.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-4 lg:p-6">
        <EmptyState
          icon="menu_book"
          title={t('emptyTitle')}
          description={t('emptyDescription')}
          className="w-full max-w-lg"
          action={
            <Button variant="primary" onClick={handleNewDoc} iconStart={<Icon name="add" size={14} />}>
              {t('newDoc')}
            </Button>
          }
        />
      </div>
    );
  }

  // story #3493 — doc.updated_at은 "기록"(마지막으로 편집된 시점) — 3436 묶음 8 정본(formatRelativeTime)으로 통일.
  const formatDate = (s: string | undefined) => (s ? formatViewerRelativeTime(s, locale, displayTimezone) : '—');
  const [lead, ...rest] = filtered;

  // story 4892 (UI-9 문서 화면 배치 · 첫 화면) — 시안(홈 · 보드 · 대화)의 B 뼈대: 머리줄(제목 + 개수 · 오른쪽 보기 전환 + 새 문서) → 필터 한 줄(분류 · 상태) → 촘촘한 줄 목록.
  // 예전 에디토리얼 마스트헤드(kicker · 큰 제목 · 시그니처 선 · 해설 문장)는 걷었다 — 같은 정보(개수)는 머리줄에, 해설 문장(indexDek)은 쓰지 않는다. 분류 · 상태 필터 · 격자 전환 · 리드 카드 · 줄 이동은 그대로.
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div data-testid="docs-index-head" className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-ds-line bg-ds-background px-4 py-1.5 lg:px-8">
        <div className="flex min-w-0 flex-1 basis-[11rem] items-baseline gap-2">
          <h1 className="m-0 min-w-0 truncate text-ds-card-title font-semibold text-ds-ink">{t('title')}</h1>
          <span data-testid="docs-index-count" className="shrink-0 font-mono text-ds-mono-md text-ds-ink-3">{items.length}</span>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <div role="group" aria-label={t('viewModeLabel')} className="flex items-center gap-0.5 rounded-ds-control border border-ds-line p-0.5">
            <IconButton icon="view_list" label={t('indexViewList')} aria-pressed={viewMode === 'list'} onClick={() => setViewMode('list')} className={viewMode === 'list' ? 'bg-ds-surface-high text-ds-ink' : undefined} />
            <IconButton icon="grid_view" label={t('indexViewGrid')} aria-pressed={viewMode === 'grid'} onClick={() => setViewMode('grid')} className={viewMode === 'grid' ? 'bg-ds-surface-high text-ds-ink' : undefined} />
          </div>
          <Button variant="primary" onClick={handleNewDoc} iconStart={<Icon name="add" size={14} />}>
            {t('newDoc')}
          </Button>
        </div>
      </div>

      {/* 필터 한 줄 — 분류(폴더) · 상태. 한 번에 하나(다시 누르면 풀림) · 개수는 이 뷰가 들고 있는 받은 집합 기준(위 주석 그대로). */}
      <div data-testid="docs-index-filters" className="flex shrink-0 flex-wrap items-center gap-1 border-b border-ds-line px-4 py-1.5 lg:px-8">
        <Button variant={categoryFilter === null ? 'secondary' : 'quiet'} aria-pressed={categoryFilter === null} onClick={() => setCategoryFilter(null)}>
          {t('indexCategoryAll')} <span className="font-mono text-ds-mono-md text-ds-ink-3">{items.length}</span>
        </Button>
        {folders.map((f) => (
          <Button key={f.id} variant={categoryFilter === f.id ? 'secondary' : 'quiet'} aria-pressed={categoryFilter === f.id} onClick={() => setCategoryFilter(f.id)}>
            {f.title} <span className="font-mono text-ds-mono-md text-ds-ink-3">{categoryCounts[f.id] ?? 0}</span>
          </Button>
        ))}
        {categoryCounts[UNCATEGORIZED] > 0 && (
          <Button variant={categoryFilter === UNCATEGORIZED ? 'secondary' : 'quiet'} aria-pressed={categoryFilter === UNCATEGORIZED} onClick={() => setCategoryFilter(UNCATEGORIZED)}>
            {t('indexCategoryUncategorized')} <span className="font-mono text-ds-mono-md text-ds-ink-3">{categoryCounts[UNCATEGORIZED]}</span>
          </Button>
        )}

        <span className="mx-1 h-4 w-px bg-ds-line" aria-hidden="true" />

        {STATUS_FILTERS.map((s) => (
          <Button key={s} variant={statusFilter === s ? 'secondary' : 'quiet'} aria-pressed={statusFilter === s} onClick={() => setStatusFilter((prev) => (prev === s ? null : s))}>
            <DocStatusChip status={s} />
            <span className="font-mono text-ds-mono-md text-ds-ink-3">{statusCounts[s]}</span>
          </Button>
        ))}
      </div>

      <div className="focus-inset flex-1 overflow-y-auto px-4 py-3 lg:px-8">
        {filtered.length === 0 ? (
          <p className="py-10 text-center text-ds-small text-ds-ink-3">{t('indexNoResults')}</p>
        ) : viewMode === 'grid' ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((doc) => (
              <Card key={doc.id} className="p-0">
                <button type="button" onClick={() => goToDoc(doc.slug)} className="flex h-full w-full flex-col items-start gap-2 rounded-ds-control p-4 text-left outline-none transition-colors hover:bg-ds-surface-high focus-visible:ring-2 focus-visible:ring-ds-action touch:min-h-11">
                  <DocStatusChip status={doc.status} />
                  <span className="line-clamp-2 text-ds-card-title font-semibold text-ds-ink">{doc.title}</span>
                  <span className="mt-auto font-mono text-ds-mono-md text-ds-ink-3">{formatDate(doc.updated_at)}</span>
                </button>
              </Card>
            ))}
          </div>
        ) : (
          <>
            {lead ? (
              <Card className="mb-3 border-l-4 border-l-ds-line-strong p-0">
                <button type="button" onClick={() => goToDoc(lead.slug)} className="flex w-full flex-col items-start gap-2 rounded-ds-control px-5 py-4 text-left outline-none transition-colors hover:bg-ds-surface-high focus-visible:ring-2 focus-visible:ring-ds-action touch:min-h-11">
                  <div className="flex items-center gap-2.5">
                    <DocStatusChip status={lead.status} />
                    <span className="text-ds-small text-ds-ink-3">{t('indexLeadBadge')}</span>
                  </div>
                  <h2 className="m-0 text-ds-title font-semibold text-ds-ink">{lead.title}</h2>
                  <div className="font-mono text-ds-mono-md text-ds-ink-3">{formatDate(lead.updated_at)}</div>
                </button>
              </Card>
            ) : null}
            <ul className="divide-y divide-ds-line">
              {rest.map((doc) => (
                <li key={doc.id}>
                  <ListRow
                    asChild
                    density="compact"
                    leading={undefined}
                    trailing={undefined}
                  >
                    <button type="button" onClick={() => goToDoc(doc.slug)} className="grid w-full grid-cols-[auto_1fr_auto] items-center gap-3 text-left">
                      <DocStatusChip status={doc.status} />
                      <span className="min-w-0 truncate text-ds-body font-semibold text-ds-ink">{doc.title}</span>
                      <span className="shrink-0 font-mono text-ds-mono-md text-ds-ink-3">{formatDate(doc.updated_at)}</span>
                    </button>
                  </ListRow>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
