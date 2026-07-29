'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ExternalLink, X, FileText, File, Layers, CheckSquare, Eye,
  Calendar, Image, FlaskConical, Paperclip, type LucideIcon,
} from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { docViewUrl } from '@/components/docs/lib/doc-project-url';
import { initials } from '@/lib/storage/format';

// story #2302 — 이 8종은 BE reference_registry.py ENTITY_RESOLVERS 와 키 집합이 같아야 한다
// (AC2·AC5, entity-icons.registry-parity.test.ts 가 코드스캔으로 대조). `asset`은 registry
// 밖 FE 전용 타입(AC5 명시 예외) — 아이콘을 **일부러** 안 준다: asset은 이미지/PDF/영상 등
// content-type이 제각각이라 타입 레벨 단일 아이콘이 의미가 없고(개별 파일 아이콘은
// getFileIcon이 파일별로 처리), "아이콘 없으면 이름 글자로"가 AC4가 못박은 **기본값**이지
// asset만의 예외 처리가 아니다 — 그래서 이 fallback은 `resolveEntityIcon()`이 모든 타입에
// 공통 적용한다(Hash 캐치올을 버림 — 있지도 않은 아이콘을 그리는 거짓보다 글자가 정직하다).
export const ENTITY_ICONS: Record<string, LucideIcon> = {
  story: FileText,
  doc: File,
  epic: Layers,
  task: CheckSquare,
  sprint: Calendar,
  artifact: Image,
  hypothesis: FlaskConical,
  evidence: Paperclip,
};

/** ENTITY_ICONS에 없는 타입(지금은 asset뿐) → 아이콘 대신 이름 첫 글자(들). 예외 처리 아님(위 주석). */
export function resolveEntityIcon(entityType: string): LucideIcon | null {
  return ENTITY_ICONS[entityType] ?? null;
}

/** 아이콘이 없는 타입(asset)의 렌더 지점 3곳(모달 헤더·EmbedCard·EntityChip)이 각자 Hash로
 * 캐치올하지 않고 한 곳에서 초성/이니셜 폴백을 공유하게 — 새 타입이 추가돼도 렌더 지점마다
 * 따로 안 고쳐도 된다. Icon은 호출부에서 미리 resolve해 prop으로 받는다(레포 관례 —
 * storage-file-glyph.tsx 동일 주석: 컴포넌트 스코프 안에서 lookup한 컴포넌트를 바로 JSX로 쓰면
 * `react-hooks/static-components`에 걸린다). */
function EntityGlyph({ Icon, label, className }: { Icon: LucideIcon | null; label: string; className?: string }) {
  if (Icon) return <Icon className={className ?? 'size-4 shrink-0'} />;
  return <span className={`flex items-center justify-center text-[10px] font-bold ${className ?? 'size-4 shrink-0'}`}>{initials(label)}</span>;
}

// 엔티티 신호 토큰(하드코딩 blue/purple/emerald/slate 제거·다크 자동 정합). 타입별 절제 틴트.
// ⛔AC4: ②/③(담긴 곳으로 보내거나 갈 곳이 없는) 상태에서는 이 틴트를 쓰지 않고 GRAY_STATE_COLOR로
// 덮어쓴다(회색 하나로 통일 — 노랑 금지 근거는 그 상수 주석 참고). 여기 있는 색은 **①일 때만** 보인다.
const ENTITY_COLORS: Record<string, string> = {
  story: 'border-info/30 bg-info/8 text-foreground',
  doc: 'border-border bg-muted/40 text-foreground',
  epic: 'border-secondary bg-secondary/40 text-foreground',
  task: 'border-success/30 bg-success/8 text-foreground',
  sprint: 'border-warning/30 bg-warning/8 text-foreground',
  artifact: 'border-info/30 bg-info/8 text-foreground',
  hypothesis: 'border-border bg-muted/40 text-foreground',
  evidence: 'border-border bg-muted/40 text-foreground',
  // S6: 스토리지 자산 토큰 — info 틴트(파일 아이콘은 content-type 의존이라 AssetEmbedCard 에서 getFileIcon 처리).
  asset: 'border-info/30 bg-info/8 text-foreground',
};

// ⛔AC4 색 규율: 노랑 금지 — 노랑은 "기다리면 풀리는 것"인데 ②/③은 사용자가 기다려서 풀 수
// 있는 상태가 아니다(담긴 곳으로 보내거나, 애초에 갈 곳이 없는 것). 구별은 색이 아니라 말로.
export const GRAY_STATE_COLOR = 'border-border bg-muted/40 text-muted-foreground';

/** story #2302 — task·evidence는 항상 담긴 곳(②) 또는 미승격(③) 판정에 own-href가 없다(모델
 * FK 그대로: Task.story_id/Evidence.work_item_id 항상 NOT NULL — 항상 유일한 부모, 모호함 0).
 * hypothesis는 링크테이블 3종(epic/story/sprint 다대다)이라 "담긴 곳 하나"를 정할 수 없어 항상
 * ③(만료조건: hypothesis 전용 화면이 생기면 ①로 승격). artifact는 story_id/epic_id/doc_id가
 * 전부 nullable·최대 1개뿐이라(hypothesis처럼 여럿 동시가능이 아님) 레코드마다 갈린다 —
 * EntityPreviewModal이 fetch한 detail로 판정(이 함수는 own-href만 다뤄 null 반환).
 * evidence는 #2314(GET /api/v2/evidence/{id} 개통) 전까지 임시 ③ — 그 라우트가 열리면 이 값을
 * task와 동형으로 승격한다(PO 확認, 2026-07-29).
 */
export function getEntityHref(entityType: string, entityId: string): string | null {
  switch (entityType) {
    case 'story': return `/board?story=${entityId}`;
    case 'doc': return `/docs?id=${entityId}`;
    // AC1 — 은퇴한 이름(/epics/)이 주소로 남아 404였다. 모델은 Goal, 화면은 goals/[id]/page.tsx.
    case 'epic': return `/goals/${entityId}`;
    // sprint는 sprints-client.tsx가 `?id=`를 실제로 읽어 자동선택한다(딥링크 주석 확認됨) — ①.
    case 'sprint': return `/sprints?id=${entityId}`;
    case 'asset': return `/storage?asset=${entityId}`;
    case 'task': return null; // ② — 부모 story_id는 EntityPreviewModal이 fetch 후 판정.
    case 'artifact': return null; // 레코드마다 ②/③ — 위 함수 doc 참고.
    case 'hypothesis': return null; // ③ 고정 — 위 함수 doc 참고.
    case 'evidence': return null; // ③ 임시(#2314 대기) — 위 함수 doc 참고.
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
  // story #2302 — task.story_id(항상 유일 부모)·artifact.{story_id,epic_id,doc_id}(최대 1개,
  // 전부 nullable)를 읽어 ②/③을 레코드 단위로 판정하는 재료. hypothesis·evidence는 의도적으로
  // 여기 없다(위 getEntityHref 주석 참고 — 애초에 fetch할 필요가 없는 고정 ③).
  task: (id) => `/api/tasks/${id}`,
  artifact: (id) => `/api/visual-artifacts/${id}`,
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
  // story #2165: 코드블럭은 전역 스크롤바 숨김 예외.
  pre: ({ children }: { children?: React.ReactNode }) => <pre className="mb-2 overflow-x-auto scrollbar-visible rounded-lg p-3 text-[13px] bg-muted">{children}</pre>,
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
  // story #2302 — hypothesis·evidence는 fetch 자체를 안 한다(항상 고정 ③, ENTITY_API에 항목
  // 없음) — 예전 코드는 'task'만 예외 취급해 loading을 false로 시작했는데, ENTITY_API에 없는
  // 다른 타입(hypothesis·evidence·미등록 타입)은 아래 effect의 `if (!url) return` 이 loading을
  // 영영 false로 안 만들어 **무한 스피너**였다(실측으로 발견 — 이 스토리가 고치기 전까지 잠복
  // 결함). fetch 전략이 있는 타입(doc 특수분기 포함)만 loading=true로 시작한다.
  const hasFetchStrategy = entityType === 'doc' || Boolean(ENTITY_API[entityType]);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(hasFetchStrategy);
  // ㉠ "대상이 없습니다" 판정 — fetch를 **시도했는데** 실패한 경우만 켠다(fetch를 아예 안 하는
  // hypothesis·evidence는 "존재하는지 모른다"이지 "없다"가 아니다 — 다른 결론을 함부로 안 낸다).
  const [notFound, setNotFound] = useState(false);
  // #2168 PR-①: docPreview 가 이 doc이 실제로 속한 project(project_id)+경로 세그먼트
  // (org_slug/project_slug)를 함께 내려준다 — "현재 프로젝트"(useDashboardContext)를 더는
  // 추측에 쓰지 않는다. 크로스프로젝트 임베드(다른 project 문서가 채팅에 임베드된 경우)는
  // 현재 프로젝트로 조회하면 project_id AND 필터에 안 걸려 항상 실패했던 것이 원 결함
  // (조사 로그: story #2168 참조) — 링크가 스스로 자기 project 를 실어 나르는 것이 처방.
  const [docPreview, setDocPreview] = useState<{
    slug: string; projectId: string; orgSlug: string; projectSlug: string | null;
  } | null>(null);

  // story #2061: 손수 구현 Escape 핸들러 제거 — 공용 Dialog(base-ui)가 Escape/backdrop-click/
  // 포커스 트랩/반환을 전부 내장한다(중복 핸들러 방지).

  useEffect(() => {
    let cancelled = false;

    if (entityType === 'doc') {
      // #2168 PR-①: doc은 2단계 — ①/api/docs/preview?q=(slug-or-uuid)로 entityId(uuid)를
      // slug+**실제 project_id/org_slug/project_slug**로 해소 ②그 project_id(현재 프로젝트가
      // 아니라 doc 자신의 project)로 본문 조회(getDoc, 다른 doc 뷰 표면과 동일 SSOT 패턴).
      // /api/docs/{id}(lightweight timestamp-only)를 "풀 doc 조회"로 오인했던 게 원 결함(#1996).
      void (async () => {
        try {
          const previewRes = await fetch(`/api/docs/preview?q=${encodeURIComponent(entityId)}`);
          if (!previewRes.ok) throw new Error();
          const previewJson = (await previewRes.json()) as {
            data?: { slug?: string; projectId?: string; orgSlug?: string; projectSlug?: string | null };
          };
          const slug = previewJson.data?.slug;
          const docProjectId = previewJson.data?.projectId;
          if (!slug || !docProjectId) throw new Error();
          if (!cancelled) {
            setDocPreview({
              slug, projectId: docProjectId,
              orgSlug: previewJson.data?.orgSlug ?? '',
              projectSlug: previewJson.data?.projectSlug ?? null,
            });
          }
          const docRes = await fetch(`/api/docs?project_id=${docProjectId}&slug=${encodeURIComponent(slug)}`);
          if (!docRes.ok) throw new Error();
          const docJson = (await docRes.json()) as { data?: Record<string, unknown> };
          if (!cancelled) setDetail(docJson.data ?? null);
        } catch {
          if (!cancelled) setNotFound(true); // ㉠ — preview 해소든 본문 조회든 실패=대상이 없다.
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
      return () => { cancelled = true; };
    }

    const url = ENTITY_API[entityType]?.(entityId);
    if (!url) return; // hypothesis·evidence 등 — fetch 전략 자체가 없다(loading도 이미 false로 시작).
    fetch(url)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((json) => { if (!cancelled) setDetail((json as { data?: Record<string, unknown> }).data ?? json as Record<string, unknown>); })
      .catch(() => { if (!cancelled) setNotFound(true); }) // ㉠ — 조회 실패=대상이 없다(story #2299 still_exists와 같은 원리).
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [entityType, entityId, hasFetchStrategy]);

  const colorClass = ENTITY_COLORS[entityType] ?? GRAY_STATE_COLOR;
  const label = title ?? entityId;

  // story #2302 AC3 — ①own-href(정적) / ②via-parent(레코드 fetch 필요) / ③없음, 세 갈래를
  // "카드 전체를 죽이지 않는다"(AC4) 원칙대로 여기서만 계산 — 헤더의 아이콘·제목·상태는 이 값과
  // 무관하게 항상 그대로 보인다(아래 return, 안 바뀜). 바뀌는 건 풋터의 링크/문구뿐이다.
  type LinkKind = 'own' | 'via-parent' | null;
  let resolvedHref: string | null;
  let linkKind: LinkKind;
  if (entityType === 'doc') {
    // #2168 PR-①: org_slug+project_slug 가 있으면 `/{ws}/{proj}/docs/{slug}/view`로 직행 —
    // CURRENT_PROJECT_COOKIE 기반 middleware 추측(proxy.ts redirectLegacyResourcePath, "현재
    // 프로젝트"만 봄)을 거치지 않아 크로스프로젝트에서도 항상 맞는 project 로 착지한다.
    // project_slug 가 없으면(옛 미백필 프로젝트, Project.slug nullable) 예전 bare 링크로 우아하게
    // 폴백 — 그 경우는 기존과 동일하게 middleware 추측에 의존(회귀 아님, 기존 동작 유지).
    resolvedHref = docPreview
      ? (docPreview.orgSlug && docPreview.projectSlug
          ? docViewUrl(docPreview.orgSlug, docPreview.projectSlug, docPreview.slug)
          : `/docs/${docPreview.slug}/view`)
      : null;
    linkKind = resolvedHref ? 'own' : null;
  } else if (entityType === 'task') {
    // ② — Task.story_id는 NOT NULL(항상 유일 부모). fetch 전이면 아직 null(풋터는 loading이 가림).
    const storyId = (detail as { story_id?: string } | null)?.story_id ?? null;
    resolvedHref = storyId ? `/board?story=${storyId}` : null;
    linkKind = resolvedHref ? 'via-parent' : null;
  } else if (entityType === 'artifact') {
    // 레코드마다 갈린다(story #2302 그라운딩) — story_id/epic_id/doc_id 전부 nullable·최대 1개
    // (hypothesis의 다대다 링크테이블과 다른 모양이라 "하나 고르면 나머지를 숨기는 거짓"이 될
    // 위험이 없다). 우선순위는 story>epic>doc — 동시에 여럿 있을 수 없어(모델 제약은 아니지만
    // 실질적으로 최대 1개라는 그라운딩 전제) 순서 자체가 결과를 바꾸지 않는다.
    const d = detail as { story_id?: string | null; epic_id?: string | null; doc_id?: string | null } | null;
    const parentHref = d?.story_id ? `/board?story=${d.story_id}`
      : d?.epic_id ? `/goals/${d.epic_id}`
      : d?.doc_id ? `/docs?id=${d.doc_id}`
      : null;
    resolvedHref = parentHref;
    linkKind = parentHref ? 'via-parent' : null;
  } else if (entityType === 'hypothesis' || entityType === 'evidence') {
    // ③ 고정(hypothesis) / ③ 임시(evidence, #2314 대기) — 위 getEntityHref 주석 참고.
    resolvedHref = null;
    linkKind = null;
  } else {
    // story·epic·sprint·asset — 전부 own-href를 동기로 아는 ①. href prop 그대로 신뢰.
    resolvedHref = href;
    linkKind = href ? 'own' : null;
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="flex max-h-[80vh] max-w-3xl flex-col overflow-hidden rounded-xl p-0" showCloseButton={false}>
        {/* Header */}
        <div className="flex-shrink-0 flex items-start gap-3 px-6 pt-5 pb-3 border-b border-border">
          <div className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm ${colorClass} flex-1 min-w-0`}>
            <EntityGlyph Icon={resolveEntityIcon(entityType)} label={label} />
            <DialogTitle className="font-semibold truncate text-sm">{label}</DialogTitle>
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
          ) : notFound ? (
            <p className="text-xs text-muted-foreground py-4">대상을 찾을 수 없습니다.</p>
          ) : detail && (entityType === 'story' || entityType === 'epic' || entityType === 'doc') ? (
            <EntityDetail entityType={entityType} detail={detail} />
          ) : (
            <p className="text-xs text-muted-foreground py-4">이 엔티티는 별도 미리보기가 없습니다.</p>
          )}
        </div>
        {/* Footer — story #2302 AC4: ㉠/㉡-b는 회색·기본커서로 "죽는 건 링크뿐"(카드 전체 안
            죽음). 색은 회색 하나(노랑 금지 — 위 GRAY_STATE_COLOR 주석 참고), 구별은 문구로. */}
        {!loading && (
          <div className="flex-shrink-0 px-6 py-3 border-t border-border">
            {notFound ? (
              <span className="flex cursor-default items-center gap-1.5 text-sm text-muted-foreground">대상이 없습니다</span>
            ) : resolvedHref ? (
              <Link
                href={resolvedHref}
                onClick={onClose}
                className="flex items-center gap-1.5 text-sm text-primary hover:underline"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                {linkKind === 'via-parent' ? '담긴 곳으로 갑니다' : '전체 보기'}
              </Link>
            ) : (
              <span className="flex cursor-default items-center gap-1.5 text-sm text-muted-foreground">열 수 있는 화면이 없습니다</span>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function EmbedCard({ entity_type, entity_id, title, status }: EmbedCardData) {
  const [showModal, setShowModal] = useState(false);
  const [navigating, setNavigating] = useState(false);
  const router = useRouter();
  const colorClass = ENTITY_COLORS[entity_type] ?? GRAY_STATE_COLOR;
  const href = getEntityHref(entity_type, entity_id);
  const label = title ?? entity_id;

  const handleDocClick = useCallback(async () => {
    setNavigating(true);
    try {
      // story #1996: /api/docs/{id}는 lightweight timestamp-only 엔드포인트(`{updated_at}`만
      // 반환) — 이 컴포넌트가 실측 이전엔 `data.slug`를 기대해왔으나 실제로 항상 undefined였다
      // (`/docs/undefined/view`로 404). /api/docs/preview?q=가 id→slug 해소 전용 엔드포인트.
      //
      // #2168 PR-①: 이 카드가 채팅에 임베드된 doc이 "현재 프로젝트"와 다를 때(크로스프로젝트
      // 링크)의 바로 그 원 결함 지점 — bare `/docs/{slug}/view`는 middleware(proxy.ts)가
      // CURRENT_PROJECT_COOKIE로 project를 추측해 다른 project의 doc이면 못 찾았다(조사 로그:
      // story #2168 참조). preview 응답의 org_slug/project_slug(doc 자신의 실제 project)로
      // 직행하면 이 추측 자체가 필요 없어진다 — project_slug 없으면(옛 미백필) bare 링크로 폴백.
      const res = await fetch(`/api/docs/preview?q=${encodeURIComponent(entity_id)}`);
      if (!res.ok) throw new Error();
      const { data } = await res.json() as {
        data: { slug: string; orgSlug?: string; projectSlug?: string | null };
      };
      const target = (data.orgSlug && data.projectSlug)
        ? docViewUrl(data.orgSlug, data.projectSlug, data.slug)
        : `/docs/${data.slug}/view`;
      router.push(target);
    } catch {
      setNavigating(false);
    }
  }, [entity_id, router]);

  const inner = (
    <div className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${colorClass}`}>
      <EntityGlyph Icon={resolveEntityIcon(entity_type)} label={label} />
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
            <EntityGlyph Icon={resolveEntityIcon(entity_type)} label={label} />
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
  const colorClass = ENTITY_COLORS[entityType] ?? GRAY_STATE_COLOR;

  const inner = (
    <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs font-medium ${colorClass}`}>
      <EntityGlyph Icon={resolveEntityIcon(entityType)} label={label} className="size-3 shrink-0" />
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
