'use client';

import { useEffect, useMemo, useState, useRef, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { DocContentRenderer } from '@/components/docs/doc-content-renderer';
import { DocToc } from '@/components/docs/doc-toc';
import { DocMiniToc } from '@/components/docs/doc-mini-toc';
import { useActiveDocHeading } from '@/components/docs/doc-active-heading';
import { extractDocHeadings } from '@/components/docs/doc-heading-utils';
import { DocStatusHeader, DocEvidenceRail } from '@/components/docs/doc-status-rail';
import { IconButton } from '@/components/ds/icon-button';
import { Icon } from '@/components/ds/icon';
import { DocModeSwitch } from '@/components/docs/doc-mode-switch';
import { DocShareDialog } from '@/components/docs/doc-share-dialog';
import { useDocDelete } from '@/components/docs/use-doc-delete';
import { HumanOnlyAction } from '@/components/ui/human-only-action';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ds/menu';
import { DocStatusChip } from '@/components/docs/doc-status-chip';
import { useDocsLayout } from '../../docs-context';
import { docUrl, docsListUrl } from '@/components/docs/lib/doc-project-url';
import { EntityBacklinksSection } from '@/components/shared/entity-backlinks-section';
import { fetchWithAuth } from '@/lib/db/client';
import { formatViewerRelativeTime } from '@/lib/storage/format';
import { useViewerTimeZone } from '@/components/viewer-time-zone';

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
  // story 4892 — a sprint report is read-only (the editor page opens it non-editable and hides «삭제»); the reading screen must not offer what the editor hides.
  doc_type?: string;
  parent_id?: string | null;
  updated_at?: string;
  assignee?: { id: string; name: string } | null;
  revisions?: { count: number; latest_at: string | null } | null;
  // story #4313 — 본문 위키 링크 {적힌 slug → 지금 slug}(BE slug 단건 경로 · BFF getBySlug가 실어 옴). 여기 든 것만 링크 · 주소는 지금 slug.
  wiki_link_targets?: Record<string, string> | null;
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
  const ts = useTranslations('share');
  const router = useRouter();
  const locale = useLocale();
  const displayTimezone = useViewerTimeZone(); // story #4443 PR2b — the viewer's zone (null until known)
  const { wsSlug, projSlug, projectId, tree, setTree } = useDocsLayout();

  const [doc, setDoc] = useState<DocState>(null);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  // story 4892 — the same delete as the editor page (confirm → DELETE → toast on failure / leave the page on success).
  const handleDelete = useDocDelete({ docId: doc ? doc.id : undefined, projectId, wsSlug, projSlug, router, setTree });
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

  // story #3946(유나 확認·페드루 정정) — doc이 아직 안 왔거나(null) 못 찾았을 때(false)
  // 본문 마스트헤드(:150의 doc.title h1)가 안 그려져 페이지 h1이 0개가 되던 gap. 시각은
  // 무변(sr-only) — docs-index.tsx와 같은 원칙, 같은 정본 키(docs.title)를 쓴다(doc
  // 자체 제목은 이 시점에 아직 모른다 — 지어내지 않는다).
  if (doc === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <h1 className="sr-only">{t('title')}</h1>
        <p className="text-ds-small text-ds-ink-3">{t('loading')}</p>
      </div>
    );
  }

  if (doc === false) {
    return (
      <div className="flex h-full items-center justify-center">
        <h1 className="sr-only">{t('title')}</h1>
        <p className="text-ds-small text-ds-ink-3">{t('notFound')}</p>
      </div>
    );
  }

  const readMinutes = estimateReadMinutes(doc.content);
  const readOnlyDoc = doc.doc_type === 'sprint_report';

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* story 4892 (UI-9 문서 화면 배치 · 상세 열 읽기) — 시안(홈 · 보드 · 대화)의 B 뼈대 «머리줄»: 1행 = 제목(h1) + 상태 · 오른쪽에 동작(목차 · 읽기|고치기 · 공유 · ⋯),
          2행 = 경로(지식 / 분류)와 메타(담당 · 갱신 · 읽기 N분 · 버전)를 한 줄로. 예전엔 경로 바 + 본문 안 분류 글 · 큰 제목 · 메타 줄이 따로 있어 같은 정보가 두 번 서고 본문이 세로로 밀렸다 —
          이제 머리에 한 번만, 본문은 바로 내용으로 시작한다. 동작 · 링크 · 메뉴 규칙은 그대로(공유 lg+ 단추 / lg 미만 메뉴 안 · 읽기 전용 문서엔 «고치기» · «삭제» 없음). */}
      {/* [SID:4356] 좁은 폭에서 «지식»이 꺾이지 않게: 뿌리 · 구분은 줄지 않고(shrink-0 · nowrap), 분류는 한 줄 말줄임. 머리는 감싼다: 제목 칸(바닥 11rem)과 동작이 한 줄에 못 들어가면(320 / 360 / 390)
          동작이 오른쪽 정렬로 둘째 줄로 내려가 제목을 밀어내지 못한다. */}
      <div data-testid="docs-reader-head" className="shrink-0 border-b border-ds-line bg-ds-background px-4 py-2 lg:px-8 lg:group-data-[collapsed=true]/docs:pl-14">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <div className="flex min-w-0 flex-1 basis-[11rem] items-center gap-2">
            <h1 className="m-0 min-w-[3rem] truncate text-ds-card-title font-semibold text-ds-ink">{doc.title}</h1>
            <DocStatusChip status={doc.status} data-testid="docs-reader-status" className="shrink-0" />
          </div>
          <span className="ml-auto flex shrink-0 items-center gap-1">
            <DocToc headings={headings} onHeadingClick={scrollToHeading} />
            {readOnlyDoc ? null : (
              <DocModeSwitch
                mode="read"
                readHref={`${docUrl(wsSlug, projSlug, slug)}/view`}
                editHref={docUrl(wsSlug, projSlug, slug)}
                readLabel={t('modeRead')}
                editLabel={t('editDoc')}
                groupLabel={t('modeSwitchLabel')}
              />
            )}
            {/* story 4892 — share and the ⋯ menu are on the reading screen too (they used to exist only on the editing screen). Below lg «공유» is inside the menu. */}
            <IconButton icon="share" label={ts('share')} onClick={() => setShareDialogOpen(true)} className="hidden lg:inline-flex" data-testid="docs-reader-share" />
            {/* story 4892 — ⋯ 메뉴 = ds Menu(Base UI: 열고 닫기 · 화살표 · Esc · 초점 복원). 항목 · 이름 · 규칙(공유 lg 미만 전용 · 읽기 전용 문서엔 삭제 없음 · 삭제는 사람만)은 그대로. */}
            <Menu>
              <MenuTrigger aria-label={t('moreActions')} className="inline-flex size-7 items-center justify-center rounded-ds-control text-ds-ink-2 transition-colors outline-none hover:bg-ds-surface-high hover:text-ds-ink focus-visible:ring-2 focus-visible:ring-ds-action touch:size-11">
                <Icon name="more_horiz" size={16} />
              </MenuTrigger>
              <MenuContent align="end" className="w-48">
                <MenuItem className="lg:hidden" icon="share" onClick={() => setShareDialogOpen(true)} data-testid="docs-reader-menu-share">
                  {ts('share')}
                </MenuItem>
                {/* story 4892 — a sprint report is read-only: no «고치기» above and no «삭제» here (the editor page hides it too; the server only lets humans delete). */}
                {readOnlyDoc ? null : (
                  <HumanOnlyAction>
                    {/* the divider belongs with «삭제»: an agent (who gets no delete) must not see a divider with nothing under it */}
                    <MenuSeparator className="lg:hidden" />
                    <MenuItem variant="danger" icon="delete" onClick={handleDelete} data-testid="docs-reader-menu-delete">
                      {t('deleteDoc')}
                    </MenuItem>
                  </HumanOnlyAction>
                )}
              </MenuContent>
            </Menu>
          </span>
        </div>
        <div data-testid="docs-reader-subline" className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-ds-small text-ds-ink-3">
          <Link href={docsListUrl(wsSlug, projSlug)} className="shrink-0 whitespace-nowrap hover:text-ds-ink hover:underline">{t('breadcrumbKnowledgeRoot')}</Link>
          <span aria-hidden="true" className="shrink-0">/</span>
          <span className="min-w-0 truncate">{categoryLabel ?? t('indexCategoryUncategorized')}</span>
          {doc.assignee ? (<><span aria-hidden="true" className="shrink-0 text-ds-line-strong">·</span><span className="shrink-0">{doc.assignee.name}</span></>) : null}
          <span aria-hidden="true" className="shrink-0 text-ds-line-strong">·</span>
          <span className="shrink-0">{doc.updated_at ? formatViewerRelativeTime(doc.updated_at, locale, displayTimezone) : ''}</span>
          <span aria-hidden="true" className="shrink-0 text-ds-line-strong">·</span>
          <span className="shrink-0">{t('readMinutes', { minutes: readMinutes })}</span>
          {doc.revisions?.count ? (<><span aria-hidden="true" className="shrink-0 text-ds-line-strong">·</span><span className="shrink-0 font-mono text-ds-mono-md">v{doc.revisions.count}</span></>) : null}
        </div>
      </div>

      <div ref={scrollRootRef} className="focus-inset flex-1 overflow-y-auto">
        {/* story 4892 (UI-9 문서 상세 열) — 오른쪽 열 = «상태 · 목차 · 이력» 패널(시안의 스레드 열처럼 본문 옆 상시 열). 상태 머리는 DOM에 한 번만 두고 자리는 CSS 격자가 정한다:
            lg(1024+)에서는 오른쪽 열 맨 위(2열 1행), 그 아래 폭에서는 DOM 순서대로 본문 맨 위. 미디어 쿼리 상태로 옮기면 첫 그림이 «아래 폭»으로 그려졌다 옮겨져 깜빡이고 이력 요청이 두 번 나가서(codex) 격자로 바꿨다. */}
        <div className="grid grid-cols-1 gap-x-8 gap-y-8 px-4 py-8 lg:grid-cols-[minmax(0,1fr)_316px] lg:gap-y-0 lg:px-8">
          <div data-testid="docs-reader-status-block" className="lg:col-start-2 lg:row-start-1 lg:border-l lg:border-ds-line lg:pb-6 lg:pl-6">
            <DocStatusHeader docId={doc.id} status={doc.status} editHref={docUrl(wsSlug, projSlug, slug)} onTransitioned={refetch} />
          </div>

          {/* 리딩 컬럼(§3) — 68ch 정본(§8 확定), 본문 렌더는 무변경(DocContentRenderer). */}
          <article className="mx-auto w-full max-w-[68ch] lg:col-start-1 lg:row-span-2 lg:row-start-1">
            <div>
              <DocContentRenderer
                content={doc.content}
                contentFormat={doc.content_format ?? 'markdown'}
                contentRef={contentRef}
                codeCopyLabel={t('codeCopy')}
                codeCopiedLabel={t('codeCopied')}
                codeCopyFailedLabel={t('codeCopyFailed')}
                assetImageErrorLabel={t('attachImageUnavailable')}
                untitledEmbedLabel={t('newDocDefaultTitle')}
                unsafeLinkLabel={t('embedLinkBlocked')}
                unsafeFileLabel={t('attachFileBlocked')}
                embedNotFoundLabel={t('notFound')}
                mermaidRenderFailedLabel={t('mermaidRenderFailed')}
                mermaidRenderingLabel={t('mermaidRendering')}
                mathRenderFailedLabel={t('mathRenderFailed')}
                suppressLeadingTitle={doc.title}
                bodyEmphasis="full"
                wikiLinkTargets={doc.wiki_link_targets}
              />
            </div>
            {/* 두 번째 backlinks 자리(첫 자리: story-detail-panel, story #2299) — 컴포넌트
                변경 0, entityType="doc" 호출만 다르다(PO 판정 그대로). */}
            <EntityBacklinksSection entityType="doc" entityId={doc.id} />
          </article>

          {/* 수직 증거 레일(§3/§6) — 접힌 gate 박스를 상시 공간으로 승격. */}
          <aside data-testid="docs-reader-rail" className="lg:col-start-2 lg:row-start-2 lg:border-l lg:border-ds-line lg:pl-6">
            {/* story #f546601e(v2 5호) — 긴 문서(N헤딩↑)만 자동 노출, 짧은 문서는 무변경
                (MINI_TOC_MIN_HEADINGS 가드는 컴포넌트 내부). */}
            <DocMiniToc headings={headings} activeId={activeHeadingId} onHeadingClick={scrollToHeading} className="mb-6" />
            <DocEvidenceRail docId={doc.id} status={doc.status} />
          </aside>
        </div>
      </div>
      <DocShareDialog
        open={shareDialogOpen}
        onClose={() => setShareDialogOpen(false)}
        docId={doc.id}
        labels={{
          share: ts('share'),
          shareToWeb: ts('shareToWeb'),
          shareToWebDesc: ts('shareToWebDesc'),
          copyLink: ts('copyLink'),
          linkCopied: ts('linkCopied'),
          stopSharing: ts('stopSharing'),
          regenerateLink: ts('regenerateLink'),
          shareSingleDocNote: ts('shareSingleDocNote'),
        }}
      />
    </div>
  );
}
