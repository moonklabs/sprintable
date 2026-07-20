'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ExternalLink, X, FileText, File, Layers, CheckSquare, Hash, Eye, type LucideIcon } from 'lucide-react';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';

// 글리프(📋📄🎯✅) → lucide. 타입 식별=아이콘·색은 신호 토큰만(다크 무파손).
export const ENTITY_ICONS: Record<string, LucideIcon> = {
  story: FileText,
  doc: File,
  epic: Layers,
  task: CheckSquare,
};

// 엔티티 신호 토큰(하드코딩 blue/purple/emerald/slate 제거·다크 자동 정합). 타입별 절제 틴트.
const ENTITY_COLORS: Record<string, string> = {
  story: 'border-info/30 bg-info/8 text-foreground',
  doc: 'border-border bg-muted/40 text-foreground',
  epic: 'border-secondary bg-secondary/40 text-foreground',
  task: 'border-success/30 bg-success/8 text-foreground',
  // S6: 스토리지 자산 토큰 — info 틴트(파일 아이콘은 content-type 의존이라 AssetEmbedCard 에서 getFileIcon 처리).
  asset: 'border-info/30 bg-info/8 text-foreground',
};

export function getEntityHref(entityType: string, entityId: string): string | null {
  switch (entityType) {
    case 'story': return `/board?story=${entityId}`;
    case 'doc': return `/docs?id=${entityId}`;
    case 'epic': return `/epics/${entityId}`;
    case 'asset': return `/storage?asset=${entityId}`;
    case 'task': return null;
    default: return null;
  }
}

export interface EmbedCardData {
  entity_type: string;
  entity_id: string;
  title: string | null;
  status: string | null;
  position?: number;
}

// story #1996: 'doc'는 여기 없다(의도적) — GET /api/docs/{id}는 lightweight timestamp-only
// polling 엔드포인트(`{ updated_at }`만 반환, route.ts 자체 주석 "Lightweight timestamp check
// for remote-change polling")라 content/slug가 없다. 전 코드(이 파일의 예전 handleDocClick
// 포함)가 이 엔드포인트를 "풀 doc 조회"로 오인해 호출해왔던 게 실측으로 드러난 진짜 결함 —
// EntityPreviewModal이 doc 타입을 별도 2단계 fetch(preview로 slug 해소→project_id+slug로
// 본문 조회, doc 뷰 페이지와 동일 패턴)로 처리한다.
const ENTITY_API: Record<string, (id: string) => string> = {
  story: (id) => `/api/stories/${id}`,
  epic: (id) => `/api/goals/${id}`,
  asset: (id) => `/api/assets/${id}`,
};

const MdBadge = ({ label }: { label: string }) => (
  <span className="rounded border px-1.5 py-0.5 text-[11px] font-medium border-border bg-muted text-muted-foreground">
    {label}
  </span>
);

// story #2021 후속(PO 리뷰): components 객체를 렌더 함수 안에서 인라인으로 만들면 매 렌더
// 새 함수 참조가 되어 react-markdown이 서브트리를 리마운트한다(chat-bubble 근본원인과 동형).
// 이 객체는 props/상태에 의존하지 않는 순수 상수이고 자식도 전부 stateless라 useMemo조차
// 불필요 — 모듈 스코프로 끌어올려 참조를 영구 고정한다.
const mdBodyComponents = {
  p: ({ children }: { children?: React.ReactNode }) => <p className="mb-2 text-sm leading-6">{children}</p>,
  h1: ({ children }: { children?: React.ReactNode }) => <h1 className="mb-2 text-lg font-bold">{children}</h1>,
  h2: ({ children }: { children?: React.ReactNode }) => <h2 className="mb-2 text-base font-bold">{children}</h2>,
  h3: ({ children }: { children?: React.ReactNode }) => <h3 className="mb-1.5 text-sm font-bold">{children}</h3>,
  ul: ({ children }: { children?: React.ReactNode }) => <ul className="mb-2 ml-4 list-disc space-y-0.5">{children}</ul>,
  ol: ({ children }: { children?: React.ReactNode }) => <ol className="mb-2 ml-4 list-decimal space-y-0.5">{children}</ol>,
  li: ({ children }: { children?: React.ReactNode }) => <li className="text-sm leading-6">{children}</li>,
  pre: ({ children }: { children?: React.ReactNode }) => <pre className="mb-2 overflow-x-auto rounded-lg p-3 text-[13px] bg-muted">{children}</pre>,
  code: ({ children }: { children?: React.ReactNode }) => <code className="rounded px-1 py-0.5 font-mono text-[13px] bg-muted">{children}</code>,
  blockquote: ({ children }: { children?: React.ReactNode }) => <blockquote className="mb-2 border-l-2 pl-3 border-border text-muted-foreground">{children}</blockquote>,
  strong: ({ children }: { children?: React.ReactNode }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }: { children?: React.ReactNode }) => <em className="italic">{children}</em>,
};

const MdBody = ({ content }: { content: string }) => (
  <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdBodyComponents}>
    {content}
  </ReactMarkdown>
);

function EntityDetail({ entityType, detail }: { entityType: string; detail: Record<string, unknown> }) {
  if (entityType === 'story') {
    const d = detail as { status?: string; priority?: string; story_points?: number; description?: string; acceptance_criteria?: string };
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {d.status && <MdBadge label={d.status} />}
          {d.priority && <MdBadge label={d.priority} />}
          {d.story_points != null && <MdBadge label={`${d.story_points} SP`} />}
        </div>
        {d.description && <MdBody content={d.description} />}
        {d.acceptance_criteria && (
          <div className="border-t border-border pt-3">
            <p className="text-xs font-semibold text-muted-foreground mb-1">Acceptance Criteria</p>
            <MdBody content={d.acceptance_criteria} />
          </div>
        )}
      </div>
    );
  }

  if (entityType === 'epic') {
    const d = detail as { status?: string; priority?: string; objective?: string; description?: string; target_date?: string; story_points_target?: number };
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {d.status && <MdBadge label={d.status} />}
          {d.priority && <MdBadge label={d.priority} />}
          {d.story_points_target != null && <MdBadge label={`목표 ${d.story_points_target} SP`} />}
          {d.target_date && <MdBadge label={d.target_date} />}
        </div>
        {d.objective && <MdBody content={d.objective} />}
        {d.description && d.description !== d.objective && <MdBody content={d.description} />}
      </div>
    );
  }

  if (entityType === 'doc') {
    const d = detail as { content?: string };
    return d.content ? <MdBody content={d.content} /> : null;
  }

  return null;
}

function EntityPreviewModal({
  entityType,
  entityId,
  title,
  status,
  href,
  onClose,
}: {
  entityType: string;
  entityId: string;
  title: string | null;
  status: string | null;
  href: string | null;
  onClose: () => void;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(entityType !== 'task');
  // story #1996: doc 본문 조회는 project_id+slug 조합 엔드포인트(getDoc)라 project_id가
  // 필요 — doc 뷰 페이지([slug]/view/page.tsx)와 동일 소스(useDashboardContext).
  const { projectId } = useDashboardContext();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;

    if (entityType === 'doc') {
      // story #1996: doc은 2단계 — ①/api/docs/preview?q=(slug-or-uuid)로 entityId(uuid)를
      // slug로 해소 ②project_id+slug로 본문 조회(getDoc, 다른 doc 뷰 표면과 동일 SSOT 패턴).
      // /api/docs/{id}(lightweight timestamp-only)를 "풀 doc 조회"로 오인했던 게 원 결함.
      if (!projectId) { setLoading(false); return; }
      void (async () => {
        try {
          const previewRes = await fetch(`/api/docs/preview?q=${encodeURIComponent(entityId)}`);
          if (!previewRes.ok) throw new Error();
          const previewJson = (await previewRes.json()) as { data?: { slug?: string } };
          const slug = previewJson.data?.slug;
          if (!slug) throw new Error();
          const docRes = await fetch(`/api/docs?project_id=${projectId}&slug=${encodeURIComponent(slug)}`);
          if (!docRes.ok) throw new Error();
          const docJson = (await docRes.json()) as { data?: Record<string, unknown> };
          if (!cancelled) setDetail(docJson.data ?? null);
        } catch {
          /* fetch 실패 시 fallback만 표시 */
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
      return () => { cancelled = true; };
    }

    const url = ENTITY_API[entityType]?.(entityId);
    if (!url) return;
    fetch(url)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((json) => { if (!cancelled) setDetail((json as { data?: Record<string, unknown> }).data ?? json as Record<string, unknown>); })
      .catch(() => { /* fetch 실패 시 fallback만 표시 */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [entityType, entityId, projectId]);

  const handleOverlayClick = useCallback((e: React.MouseEvent) => {
    if (e.target === overlayRef.current) onClose();
  }, [onClose]);

  const Icon = ENTITY_ICONS[entityType] ?? Hash;
  const colorClass = ENTITY_COLORS[entityType] ?? 'border-border bg-muted text-foreground';
  const label = title ?? entityId;
  // story #1996: getEntityHref('doc', id)의 `/docs?id=` 는 어느 라우트도 소비하지 않는 죽은
  // 패턴(grep 0건) — 실 라우트는 slug 기반(`/docs/{slug}/view`, embed-card의 handleDocClick과
  // 동형). doc 상세 fetch(위 useEffect)가 이미 slug를 포함해 내려주므로 로드 후 그걸로 override —
  // "미리보기 살리기"가 이 죽은 링크를 처음으로 실사용 도달 가능하게 만드는 지점이라 같이 고친다.
  const docSlug = entityType === 'doc' ? (detail as { slug?: string } | null)?.slug : undefined;
  const resolvedHref = entityType === 'doc' ? (docSlug ? `/docs/${docSlug}/view` : null) : href;

  return (
    <div
      ref={overlayRef}
      onClick={handleOverlayClick}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
    >
      <div className="relative w-full max-w-3xl max-h-[80vh] flex flex-col rounded-xl border border-border bg-popover text-popover-foreground shadow-xl">
        {/* Header */}
        <div className="flex-shrink-0 flex items-start gap-3 px-6 pt-5 pb-3 border-b border-border">
          <div className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm ${colorClass} flex-1 min-w-0`}>
            <Icon className="size-4 shrink-0" />
            <span className="font-semibold truncate">{label}</span>
            {status ? (
              <span className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-xs bg-black/10 dark:bg-white/10">{status}</span>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 text-muted-foreground hover:text-foreground mt-0.5"
            aria-label="닫기"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-8 justify-center">
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
              불러오는 중…
            </div>
          ) : detail ? (
            <EntityDetail entityType={entityType} detail={detail} />
          ) : entityType === 'task' ? (
            <p className="text-xs text-muted-foreground py-4">이 엔티티는 별도 페이지가 없습니다.</p>
          ) : null}
        </div>
        {/* Footer */}
        {resolvedHref && (
          <div className="flex-shrink-0 px-6 py-3 border-t border-border">
            <Link
              href={resolvedHref}
              onClick={onClose}
              className="flex items-center gap-1.5 text-sm text-primary hover:underline"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              전체 보기
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}

export function EmbedCard({ entity_type, entity_id, title, status }: EmbedCardData) {
  const [showModal, setShowModal] = useState(false);
  const [navigating, setNavigating] = useState(false);
  const router = useRouter();
  const Icon = ENTITY_ICONS[entity_type] ?? Hash;
  const colorClass = ENTITY_COLORS[entity_type] ?? 'border-border bg-muted text-foreground';
  const href = getEntityHref(entity_type, entity_id);
  const label = title ?? entity_id;

  const handleDocClick = useCallback(async () => {
    setNavigating(true);
    try {
      // story #1996: /api/docs/{id}는 lightweight timestamp-only 엔드포인트(`{updated_at}`만
      // 반환) — 이 컴포넌트가 실측 이전엔 `data.slug`를 기대해왔으나 실제로 항상 undefined였다
      // (`/docs/undefined/view`로 404). /api/docs/preview?q=가 id→slug 해소 전용 엔드포인트.
      const res = await fetch(`/api/docs/preview?q=${encodeURIComponent(entity_id)}`);
      if (!res.ok) throw new Error();
      const { data } = await res.json() as { data: { slug: string } };
      router.push(`/docs/${data.slug}/view`);
    } catch {
      setNavigating(false);
    }
  }, [entity_id, router]);

  const inner = (
    <div className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${colorClass}`}>
      <Icon className="size-4 shrink-0" />
      <span className="font-medium">{label}</span>
      {status ? (
        <span className="ml-auto rounded px-1.5 py-0.5 text-xs bg-black/10 dark:bg-white/10">{status}</span>
      ) : null}
      {navigating && <span className="ml-auto h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />}
    </div>
  );

  if (entity_type === 'doc') {
    // story #1996(no-sloppy): 전체 카드가 항상 이동만 해 EntityPreviewModal(doc content 렌더
    // 이미 지원, EntityDetail의 doc 분기)에 도달할 방법이 없었다 — 주 클릭=이동(기존 UX 유지)·
    // 보조 아이콘=미리보기(모달)로 병렬 배치.
    return (
      <>
        <div className={`flex items-center gap-1 rounded-md border pl-3 pr-1.5 py-2 text-sm ${colorClass}`}>
          <button
            type="button"
            onClick={handleDocClick}
            disabled={navigating}
            className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:opacity-60"
          >
            <Icon className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
            {status ? (
              <span className="shrink-0 rounded px-1.5 py-0.5 text-xs bg-black/10 dark:bg-white/10">{status}</span>
            ) : null}
            {navigating && <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" />}
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setShowModal(true); }}
            className="shrink-0 rounded p-1 opacity-70 transition-opacity hover:bg-black/10 hover:opacity-100 dark:hover:bg-white/10"
            aria-label="미리보기"
            title="미리보기"
          >
            <Eye className="size-3.5" />
          </button>
        </div>
        {showModal && (
          <EntityPreviewModal
            entityType={entity_type}
            entityId={entity_id}
            title={title}
            status={status}
            href={href}
            onClose={() => setShowModal(false)}
          />
        )}
      </>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setShowModal(true)}
        className="block w-full text-left transition-opacity hover:opacity-80"
      >
        {inner}
      </button>
      {showModal && (
        <EntityPreviewModal
          entityType={entity_type}
          entityId={entity_id}
          title={title}
          status={status}
          href={href}
          onClose={() => setShowModal(false)}
        />
      )}
    </>
  );
}

export function EntityChip({
  entityType,
  entityId,
  label,
  href,
}: {
  entityType: string;
  entityId?: string;
  label: string;
  href: string | null;
}) {
  const [showModal, setShowModal] = useState(false);
  const Icon = ENTITY_ICONS[entityType] ?? Hash;
  const colorClass = ENTITY_COLORS[entityType] ?? 'border-border bg-muted text-foreground';

  const inner = (
    <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs font-medium ${colorClass}`}>
      <Icon className="size-3 shrink-0" />
      <span>{label}</span>
    </span>
  );

  if (entityId) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowModal(true)}
          className="inline-flex no-underline transition-opacity hover:opacity-80"
        >
          {inner}
        </button>
        {showModal && (
          <EntityPreviewModal
            entityType={entityType}
            entityId={entityId}
            title={label}
            status={null}
            href={href}
            onClose={() => setShowModal(false)}
          />
        )}
      </>
    );
  }

  if (href) {
    return (
      <Link href={href} className="inline-flex no-underline transition-opacity hover:opacity-80">
        {inner}
      </Link>
    );
  }
  return inner;
}
