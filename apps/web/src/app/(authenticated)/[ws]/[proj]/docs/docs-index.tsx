'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { BookOpen, LayoutGrid, List as ListIcon, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { useDocsLayout, type Doc } from './docs-context';
import { docUrl } from '@/components/docs/lib/doc-project-url';
import { DOC_STATUS_TONE, toDocStatusFilter, docStatusLabelKey, type DocStatusFilter } from '@/components/docs/lib/doc-status-tone';

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

function StatusChip({ status, size = 'sm' }: { status: string | undefined; size?: 'sm' | 'xs' }) {
  const t = useTranslations('docs');
  const s = toDocStatusFilter(status);
  const tone = DOC_STATUS_TONE[s];
  return (
    <span className={`proof-cut proof-cut-${size} inline-flex shrink-0 items-center gap-1.5 px-2.5 py-1 text-[11.5px] font-bold ${tone.bg} ${tone.text}`}>
      <span className={`size-1.5 rounded-full ${tone.dot}`} aria-hidden="true" />
      {t(docStatusLabelKey(s))}
    </span>
  );
}

export function DocsIndex() {
  const t = useTranslations('docs');
  const router = useRouter();
  const { tree, handleNewDoc, wsSlug, projSlug } = useDocsLayout();
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
  const goToDoc = (slug: string) => router.push(docUrl(wsSlug, projSlug, slug));

  // story #2955 §6(PO 요건②) — "문서를 선택하세요" 재현 금지. 0건은 에러가 아니라 만들
  // 데이터로서 설계 — 첫 문서 CTA + 왜 0인지 맥락(신규 프로젝트) 병기.
  if (tree.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-4 lg:p-6">
        <EmptyState
          icon={<BookOpen className="size-8" />}
          title={t('emptyTitle')}
          description={t('emptyDescription')}
          className="w-full max-w-lg bg-background/70"
          action={
            <Button size="sm" onClick={handleNewDoc}>
              <Plus className="mr-1 h-4 w-4" />
              {t('newDoc')}
            </Button>
          }
        />
      </div>
    );
  }

  const formatDate = (s: string | undefined) => (s ? new Date(s).toLocaleDateString() : '—');
  const [lead, ...rest] = filtered;

  return (
    <div className="h-full overflow-y-auto px-6 py-8 lg:px-10">
      {/* 마스트헤드(§2) — editorial 타이포 스케일 첫 소비처(story #2917 토큰). */}
      <div className="mb-6">
        <div className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          {t('indexKicker')}
        </div>
        {/* story #2974(PR-D0) delta — `font-editorial-heading`은 무게 유틸(--font-weight-editorial-heading:
            820, Tailwind가 자동생성)이지 페이스 토큰이 아니다. font-display 단독 치환이 무게 820을
            조용히 지웠던 걸 유나군이 배포 CSS로 실증(2026-08-23) — 페이스(font-display)+무게
            (font-editorial-heading) 병기로 복원. 정적 className이라 twMerge 충돌군 문제 없음. */}
        <h1 className="mt-2 font-display font-editorial-heading text-[46px] leading-none tracking-[-0.035em] text-foreground">
          {t('title')}
        </h1>
        {/* story #2983(유나 확定) — 정적 장식 citron 퇴출(citron=live pulse 신호 전용).
            시그니처는 무채 두께(3px)·길이로 유지. */}
        <hr className="my-4 h-[3px] w-[88px] border-0 bg-proof-line-strong" />
        <p className="text-editorial-ui text-muted-foreground">
          {t('indexDek')} <span className="text-muted-foreground">{t('indexDocCount', { count: items.length })}</span>
        </p>
      </div>

      {/* 본문 헤더 존 필터(PO 확定 — 시안 색인 레일의 카테고리·상태 정보가 여기로 이동) +
          목록/격자 토글 + 새 문서. */}
      <div className="mb-5 flex flex-wrap items-center gap-2 border-b border-border pb-4">
        <button
          type="button"
          onClick={() => setCategoryFilter(null)}
          className={`px-2.5 py-1 text-[13px] font-semibold transition ${categoryFilter === null ? 'border-b-2 border-proof-citron text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
        >
          {t('indexCategoryAll')} <span className="font-mono text-[11px] text-muted-foreground">{items.length}</span>
        </button>
        {folders.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setCategoryFilter(f.id)}
            className={`px-2.5 py-1 text-[13px] font-medium transition ${categoryFilter === f.id ? 'border-b-2 border-proof-citron text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
          >
            {f.title} <span className="font-mono text-[11px] text-muted-foreground">{categoryCounts[f.id] ?? 0}</span>
          </button>
        ))}
        {categoryCounts[UNCATEGORIZED] > 0 && (
          <button
            type="button"
            onClick={() => setCategoryFilter(UNCATEGORIZED)}
            className={`px-2.5 py-1 text-[13px] font-medium transition ${categoryFilter === UNCATEGORIZED ? 'border-b-2 border-proof-citron text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
          >
            {t('indexCategoryUncategorized')} <span className="font-mono text-[11px] text-muted-foreground">{categoryCounts[UNCATEGORIZED]}</span>
          </button>
        )}

        <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />

        {STATUS_FILTERS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatusFilter((prev) => (prev === s ? null : s))}
            aria-pressed={statusFilter === s}
            className={`transition ${statusFilter === s ? 'ring-2 ring-proof-citron' : 'opacity-80 hover:opacity-100'}`}
          >
            <StatusChip status={s} />
            <span className="ml-1 font-mono text-[10px] text-muted-foreground">{statusCounts[s]}</span>
          </button>
        ))}

        <div className="ml-auto flex items-center gap-2">
          <div className="flex overflow-hidden rounded-md border border-border">
            <button
              type="button"
              onClick={() => setViewMode('list')}
              aria-pressed={viewMode === 'list'}
              className={`flex h-7 w-7 items-center justify-center transition ${viewMode === 'list' ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted'}`}
              aria-label={t('indexViewList')}
            >
              <ListIcon className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setViewMode('grid')}
              aria-pressed={viewMode === 'grid'}
              className={`flex h-7 w-7 items-center justify-center border-l border-border transition ${viewMode === 'grid' ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted'}`}
              aria-label={t('indexViewGrid')}
            >
              <LayoutGrid className="size-3.5" />
            </button>
          </div>
          <Button size="sm" onClick={handleNewDoc}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            {t('newDoc')}
          </Button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">{t('indexNoResults')}</p>
      ) : viewMode === 'grid' ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((doc) => (
            <button
              key={doc.id}
              type="button"
              onClick={() => goToDoc(doc.slug)}
              className="flex flex-col items-start gap-2 rounded-lg border border-border bg-card p-4 text-left transition hover:border-foreground/30"
            >
              <StatusChip status={doc.status} size="xs" />
              <span className="text-editorial-claim font-editorial-claim text-foreground line-clamp-2">{doc.title}</span>
              <span className="mt-auto font-mono text-[10.5px] text-muted-foreground">{formatDate(doc.updated_at)}</span>
            </button>
          ))}
        </div>
      ) : (
        <>
          {lead ? (
            <button
              type="button"
              onClick={() => goToDoc(lead.slug)}
              className="relative mb-3 flex w-full flex-col items-start gap-2 border border-border bg-card px-6 py-5 pl-7 text-left transition hover:border-foreground/30"
            >
              <span className="absolute inset-y-0 left-0 w-1 bg-proof-citron" aria-hidden="true" />
              <div className="flex items-center gap-2.5">
                <StatusChip status={lead.status} />
                <span className="font-mono text-[11px] uppercase tracking-[0.05em] text-muted-foreground">{t('indexLeadBadge')}</span>
              </div>
              <h2 className="font-display font-editorial-heading text-[27px] leading-[1.15] tracking-[-0.02em] text-foreground">{lead.title}</h2>
              <div className="font-mono text-[12px] text-muted-foreground">{formatDate(lead.updated_at)}</div>
            </button>
          ) : null}
          <ul className="divide-y divide-border/60">
            {rest.map((doc) => (
              <li key={doc.id}>
                <button
                  type="button"
                  onClick={() => goToDoc(doc.slug)}
                  className="grid w-full grid-cols-[auto_1fr_auto] items-center gap-4 py-4 text-left transition hover:bg-muted/40"
                >
                  <StatusChip status={doc.status} />
                  <span className="min-w-0 truncate text-editorial-claim font-editorial-claim text-foreground">{doc.title}</span>
                  <span className="shrink-0 font-mono text-[11.5px] text-muted-foreground">{formatDate(doc.updated_at)}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
