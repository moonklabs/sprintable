'use client';

import { useEffect, useMemo, useState, useRef, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { DocContentRenderer } from '@/components/docs/doc-content-renderer';
import { DocToc } from '@/components/docs/doc-toc';
import { DocMiniToc } from '@/components/docs/doc-mini-toc';
import { useActiveDocHeading } from '@/components/docs/doc-active-heading';
import { extractDocHeadings } from '@/components/docs/doc-heading-utils';
import { DocStatusHeader, DocEvidenceRail } from '@/components/docs/doc-status-rail';
import { Button } from '@/components/ui/button';
import { Edit2 } from 'lucide-react';
import { useDocsLayout } from '../../docs-context';
import { docUrl, docsListUrl } from '@/components/docs/lib/doc-project-url';
import { EntityBacklinksSection } from '@/components/shared/entity-backlinks-section';
import { fetchWithAuth } from '@/lib/db/client';

interface DocDetail {
  id: string;
  title: string;
  slug: string;
  content: string;
  content_format?: 'markdown' | 'html';
  // story #2955 §3/§4 — 에디토리얼 리더 마스트헤드+상태 헤더+증거 레일용. BE(DocResponse)는
  // 이미 이 필드들을 slug-query 단건 경로에서 내려주고 있었다(doc-payload enrich) — 이
  // 옛 최소 타입엔 없었을 뿐(fetchTree/Doc 타입과 동형 갭).
  status?: string;
  parent_id?: string | null;
  updated_at?: string;
  assignee?: { id: string; name: string } | null;
  revisions?: { count: number; latest_at: string | null } | null;
}

// null = 로딩 중, false = not found, DocDetail = 로드 완료
type DocState = DocDetail | null | false;

// story #2955 §3 — "읽기 N분"은 BE 필드가 아니라 클라이언트 파생(word count/분당 표준
// 독해속도 어림). 실측 아님을 명확히 하려 분 단위까지만 표시(초 단위 정밀도 주장 안 함).
const WORDS_PER_MINUTE = 500; // 한국어 어림값(공백 기준 토큰 수 — 정밀 독해속도 연구치 아닌 실용적 상수).
function estimateReadMinutes(content: string): number {
  const words = content.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}

export default function DocViewPage() {
  const params = useParams();
  const slug = typeof params.slug === 'string' ? params.slug : '';
  const t = useTranslations('docs');
  const { wsSlug, projSlug, projectId, tree } = useDocsLayout();

  const [doc, setDoc] = useState<DocState>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const scrollRootRef = useRef<HTMLDivElement | null>(null);

  const scrollToHeading = useCallback((id: string) => {
    contentRef.current?.querySelector<HTMLElement>(`#${CSS.escape(id)}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const headings = useMemo(
    () => (doc ? extractDocHeadings(doc.content, doc.content_format ?? 'markdown') : []),
    [doc],
  );
  const activeHeadingId = useActiveDocHeading(contentRef, headings, scrollRootRef);

  useEffect(() => {
    if (!projectId || !slug) return;
    let cancelled = false;
    fetchWithAuth(`/api/docs?project_id=${projectId}&slug=${slug}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => { if (!cancelled) setDoc((json?.data as DocDetail) ?? false); })
      .catch(() => { if (!cancelled) setDoc(false); });
    return () => { cancelled = true; };
  }, [projectId, slug]);

  const refetch = useCallback(() => {
    if (!projectId || !slug) return;
    fetchWithAuth(`/api/docs?project_id=${projectId}&slug=${slug}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => { if (json?.data) setDoc(json.data as DocDetail); })
      .catch(() => {});
  }, [projectId, slug]);

  // story #2955 §3 — breadcrumb 카테고리(부모 top-level 폴더 제목). §2 인덱스와 동일 출처
  // (is_folder&&parent_id===null) — 사이드바 트리(useDocsLayout().tree)가 이미 로드한
  // 범위 안에서만 해소(별도 fetch 신설 안 함, 못 찾으면 breadcrumb에서 그 조각만 생략).
  const categoryLabel = useMemo(() => {
    if (!doc || !doc.parent_id) return null;
    const parent = tree.find((d) => d.id === doc.parent_id && d.is_folder && d.parent_id === null);
    return parent?.title ?? null;
  }, [doc, tree]);

  if (doc === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">{t('loading')}</p>
      </div>
    );
  }

  if (doc === false) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">{t('notFound')}</p>
      </div>
    );
  }

  const readMinutes = estimateReadMinutes(doc.content);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* breadcrumb 상단 바(§3) — 옛 인라인 타이틀+TOC+편집 바를 대체.
          story #2967(선생님 실사용 판정) — font-mono가 한글에서 가늘고 흐리다(에디토리얼
          mono 문법은 라틴 고정폭 전제라 한글엔 안 맞음). meta-caps는 라틴 전용으로 한정하고
          한글 경로는 sans 본문체로 — 위계는 크기/weight/citron rule로만 낸다. */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/20 px-4 py-2.5 text-[12px] text-muted-foreground lg:px-8">
        <Link href={docsListUrl(wsSlug, projSlug)} className="hover:text-foreground hover:underline">{t('breadcrumbKnowledgeRoot')}</Link>
        {categoryLabel ? (<><span className="text-muted-foreground">/</span><span>{categoryLabel}</span></>) : null}
        <span className="text-muted-foreground">/</span>
        <span className="truncate text-foreground">{doc.title}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <DocToc headings={headings} onHeadingClick={scrollToHeading} />
          <Button asChild size="sm" variant="ghost">
            <Link href={docUrl(wsSlug, projSlug, slug)}>
              <Edit2 className="mr-1.5 h-3.5 w-3.5" />
              {t('editDoc')}
            </Link>
          </Button>
        </span>
      </div>

      <div ref={scrollRootRef} className="focus-inset flex-1 overflow-y-auto">
        <div className="grid grid-cols-1 gap-8 px-4 py-8 lg:grid-cols-[minmax(0,1fr)_316px] lg:px-8">
          {/* 리딩 컬럼(§3) — 68ch 정본(§8 확定), 본문 렌더는 무변경(DocContentRenderer). */}
          <article className="mx-auto w-full max-w-[68ch]">
            {/* story #2967 — kicker/byline은 한글 콘텐츠(카테고리명·작성자명)라 mono+uppercase+
                wide tracking을 걷는다(«처방도 언어 축을 탄다» — 라틴 전용 문법을 한글에
                강제하지 않는다). 위계는 색(citron 라인 계열 blue)+굵기로만 유지. */}
            <div className="text-[13px] font-semibold text-proof-blue">
              {categoryLabel ?? t('indexCategoryUncategorized')}
            </div>
            {/* story #2974(PR-D0) delta — font-display(페이스)+font-editorial-heading(무게 유틸,
                --font-weight-editorial-heading:820) 병기. docs-index.tsx 마스트헤드 주석 참고. */}
            <h1 className="mt-2 font-display font-editorial-heading text-[38px] leading-[1.1] tracking-[-0.03em] text-foreground">{doc.title}</h1>
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted-foreground">
              {doc.assignee ? (<><span>{doc.assignee.name}</span><span className="text-border">|</span></>) : null}
              <span>{doc.updated_at ? new Date(doc.updated_at).toLocaleDateString() : ''}</span>
              <span className="text-border">|</span>
              <span>{t('readMinutes', { minutes: readMinutes })}</span>
              {doc.revisions?.count ? (<><span className="text-border">|</span><span>v{doc.revisions.count}</span></>) : null}
            </div>

            <div className="mt-6">
              <DocStatusHeader docId={doc.id} status={doc.status} editHref={docUrl(wsSlug, projSlug, slug)} onTransitioned={refetch} />
            </div>

            <div className="mt-8">
              <DocContentRenderer
                content={doc.content}
                contentFormat={doc.content_format ?? 'markdown'}
                contentRef={contentRef}
                codeCopyLabel={t('codeCopy')}
                codeCopiedLabel={t('codeCopied')}
                assetImageErrorLabel={t('attachImageUnavailable')}
                suppressLeadingTitle={doc.title}
                bodyEmphasis="full"
              />
            </div>
            {/* 두 번째 backlinks 자리(첫 자리: story-detail-panel, story #2299) — 컴포넌트
                변경 0, entityType="doc" 호출만 다르다(PO 판정 그대로). */}
            <EntityBacklinksSection entityType="doc" entityId={doc.id} />
          </article>

          {/* 수직 증거 레일(§3/§6) — 접힌 gate 박스를 상시 공간으로 승격. */}
          <aside className="lg:border-l lg:border-border lg:pl-6">
            {/* story #f546601e(v2 5호) — 긴 문서(N헤딩↑)만 자동 노출, 짧은 문서는 무변경
                (MINI_TOC_MIN_HEADINGS 가드는 컴포넌트 내부). */}
            <DocMiniToc headings={headings} activeId={activeHeadingId} onHeadingClick={scrollToHeading} className="mb-6" />
            <DocEvidenceRail docId={doc.id} status={doc.status} />
          </aside>
        </div>
      </div>
    </div>
  );
}
