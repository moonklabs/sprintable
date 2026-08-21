'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ExternalLink, X, Eye } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { docViewUrl } from '@/components/docs/lib/doc-project-url';
import { resolveScopedEntityHref, storyBoardUrl, goalUrl, sprintUrl, assetStorageUrl } from '@/lib/entity-project-url';
import { renderEntityStatusLabel, translateEntityStatus, type EntityStatusFetchState } from './entity-status-labels';
import { ArtifactThumbnail } from '@/components/canvas/artifact-thumbnail';
import { fetchWithAuth } from '@/lib/db/client';
import { parseEntityRef } from './entity-ref';
// story #2888(S2a) — 이관 후 재수출(기존 소비처 4곳 import 경로 무변경, 회귀 0). 정본은
// entity-registry.tsx 참고.
import { ENTITY_ICONS, ENTITY_COLORS, GRAY_STATE_COLOR, resolveEntityIcon, EntityGlyph } from './entity-registry';

export { ENTITY_ICONS, ENTITY_COLORS, GRAY_STATE_COLOR, resolveEntityIcon };

/** story #2302 — task·evidence는 항상 담긴 곳(②) 판정에 own-href가 없다(모델 FK 그대로:
 * Task.story_id/Evidence.work_item_id 항상 NOT NULL — 항상 유일한 부모, 모호함 0).
 * hypothesis는 링크테이블 3종(epic/story/sprint 다대다)이라 "담긴 곳 하나"를 정할 수 없어 항상
 * ③(만료조건: hypothesis 전용 화면이 생기면 ①로 승격). artifact는 story_id/epic_id/doc_id가
 * 전부 nullable·최대 1개뿐이라(hypothesis처럼 여럿 동시가능이 아님) 레코드마다 갈린다 —
 * EntityPreviewModal이 fetch한 detail로 판정(이 함수는 own-href만 다뤄 null 반환).
 * evidence는 story #2314(2026-07-29, GET /api/v2/evidence/{id} 개통)로 task와 동형인 ②로
 * 승격됐다 — work_item_type이 story든 task든 응답의 resolved_story_id(BE가 이미 한 번에
 * 해소해 준다) 하나로 EntityPreviewModal이 판정한다.
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
    case 'evidence': return null; // ② — resolved_story_id는 EntityPreviewModal이 fetch 후 판정(task와 동형).
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
  // story #2642 — sprint는 own-href(getEntityHref)라 당시엔 몸통 fetch 자체가 없었다. 크로스
  // 프로젝트 직행 URL을 지으려면 sprint 자신의 org_slug/project_slug(BE #3044, SprintResponse
  // 확장)를 알아야 해서 fetch가 필요해졌고, #2780에서 title·status·기간이 실제로 응답에
  // 있음을 확認해 RICH_PREVIEW_TYPES에 편입(EntityDetail sprint 분기).
  sprint: (id) => `/api/sprints/${id}`,
  // story #2302 — task.story_id(항상 유일 부모)·artifact.{story_id,epic_id,doc_id}(최대 1개,
  // 전부 nullable)를 읽어 ②/③을 레코드 단위로 판정하는 재료.
  task: (id) => `/api/tasks/${id}`,
  artifact: (id) => `/api/visual-artifacts/${id}`,
  // story #2314(2026-07-29): GET /api/v2/evidence/{id}가 신설돼 evidence도 fetch-eligible로
  // 승격 — 응답의 resolved_story_id를 EntityPreviewModal이 읽는다(아래 evidence 분기).
  evidence: (id) => `/api/evidence/${id}`,
  // story #2614 — hypothesis는 §2302에서 "링크(풋터) 판정용으로 fetch할 필요가 없다"(다대다라
  // 부모 하나를 못 고름, 그건 여전히 사실 — 아래 getEntityHref는 무변경)는 이유로 ENTITY_API
  // 자체에서 빠졌었는데, 그 근거가 "몸통 content도 fetch 불필요"로 잘못 일반화됐다 — statement
  // (§2.2.4 유일한 수동 텍스트 입력)는 실재하고 GET /api/hypotheses/{id}도 이미 있다(E-LOOP-LEDGER
  // S6). 풋터(갈 곳 없음)와 몸통(내용 있음)은 별개 축 — 몸통만 이제 채운다.
  hypothesis: (id) => `/api/hypotheses/${id}`,
};

// story #2614 AC2 — 멘션 합성 가능 8타입(story/doc/epic/task/sprint/artifact/hypothesis/
// evidence) 전수표. 이 Set에 없는 타입은 "이 엔티티는 별도 미리보기가 없습니다"로 떨어진다 —
// 그게 이 스토리가 고친 결함(만들 수는 있는데 몸통에서 아무것도 못 얻는 반쪽)이었다. sprint는
// own-href(getEntityHref)로 풋터가 이미 열리고 몸통에 보여줄 필드가 없어(제목·기간 외 없음)
// 의도적으로 이 Set 밖 — "미리보기 없음" 문구가 정확한 그 드문 경우(AC3의 "진짜 없는 것"에
// sprint도 포함). 새 합성 가능 타입을 추가하면 이 Set도 같이 넓히거나(몸통 있음), 의도적으로
// 빼면서 그 이유를 여기 한 줄 남길 것 — «만들 수 있는데 못 여는» 사각을 다시 만들지 않도록.
// story #2780 — task·sprint 편입(§3/페드루 판정, EntityDetail 주석 그대로 근거).
const RICH_PREVIEW_TYPES = new Set(['story', 'epic', 'doc', 'artifact', 'hypothesis', 'task', 'sprint']);

// story #2118(E-DG-REAL, 페드루 리뷰) — "폴백이 정직하다"(크래시 안 남)는 "클릭에 값이
// 있다"는 뜻이 아니다. RICH_PREVIEW도 ENTITY_API fetch 전략도 own-href(getEntityHref)도
// 셋 다 없는 타입(예: gate work_item_type의 loop·wf_line_version — entity 계열 자체에 등록
// 안 됨)은 제목을 눌러도 "미리보기 없음"+갈 곳 없는 빈 모달만 뜬다 — story #2118(P2.2)
// AC④가 이미 내린 판정("미리보기 없는 타입에 억지로 진입점 달아 빈 모달 여는 거짓 안
// 만든다")과 정면충돌. 이 판정을 한 곳에 두어 새 타입이 늘 때마다 흩어진 조건을 다시
// 맞추지 않게 한다 — 진입점을 달지 여부를 결정하는 소비부(approval-request-card.tsx 등)는
// 이 함수 하나만 부른다. getEntityHref는 entityId 값과 무관하게 entityType만으로 null 여부가
// 갈리므로(switch가 타입 단위 분기) 더미 id로도 정확하다.
export function canPreviewEntity(entityType: string): boolean {
  return RICH_PREVIEW_TYPES.has(entityType) || Boolean(ENTITY_API[entityType]) || getEntityHref(entityType, '') !== null;
}

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
  // story #2639(미르코 리뷰 ⑤) — 결재 카드 문서 미리보기(EntityPreviewModal→EntityDetail doc
  // 분기)가 이 경량 렌더러를 쓴다. doc-content-renderer와 동일하게 entity: 참조를 EntityChip으로
  // 잇는다(같은 파일의 EntityChip 재사용·사본 0). 비-UUID/asset은 평문 링크 폴백(무동작 0).
  // story #2888(S2a) — 파싱은 parseEntityRef SSOT. 이 렌더러엔 `references` 사이드밴드가
  // 없어(중첩 엔티티 본문) doc-content-renderer.tsx와 동일한 단순 2갈래(asset 제외 칩 or
  // 평문 링크)를 그대로 유지한다 — asset은 원래도 AssetEmbedCard가 아니라 평문 링크 폴백.
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => {
    const ref = parseEntityRef(href);
    if (ref && ref.entityType.toLowerCase() !== 'asset') {
      return <EntityChip entityType={ref.entityType} entityId={ref.entityId} label={String(children)} href={getEntityHref(ref.entityType, ref.entityId)} />;
    }
    return <a href={href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">{children}</a>;
  },
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

// story #2639 — entity: 스킴 보존(이 렌더러는 rehype-sanitize를 안 써서 이 한 겹이면 충분).
// 그 외 스킴은 기본 sanitize 유지(javascript:/data: 차단). export: MdBody 격리 테스트용.
export const MdBody = ({ content }: { content: string }) => (
  <ReactMarkdown
    remarkPlugins={[remarkGfm]}
    urlTransform={(url) => (url.startsWith('entity:') ? url : defaultUrlTransform(url))}
    components={mdBodyComponents}
  >
    {content}
  </ReactMarkdown>
);

// story #2780 — 컴포넌트가 아니라 순수 함수로 둔다: 호출부(embed-card 모달 body)가 반환값이
// null인지(=보여줄 내용 없음) 직접 검사해야 하는데, JSX `<EntityDetail/>` 호출은 그 반환값을
// 렌더 트리 밖에서 들여다볼 수 없다(엘리먼트 서술자는 항상 non-null이다 — 안이 null이어도).
function renderEntityDetail(entityType: string, entityId: string, detail: Record<string, unknown>): React.ReactNode | null {
  if (entityType === 'story') {
    const d = detail as { status?: string; priority?: string; story_points?: number; description?: string; acceptance_criteria?: string };
    const statusLabel = d.status ? translateEntityStatus('story', d.status) : null;
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {statusLabel && <MdBadge label={statusLabel} />}
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
    const statusLabel = d.status ? translateEntityStatus('epic', d.status) : null;
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {statusLabel && <MdBadge label={statusLabel} />}
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

  // story #2614 — 부모(story/epic/doc)가 없는 독립 artifact(챗에 바로 올린 mockup 등)는 풋터에
  // "갈 곳"이 없다(getEntityHref 주석 그대로, 변경 없음) — 그래도 몸통에서 실물을 보여주면
  // 그 자체로 소비처가 선다. 갤러리가 이미 쓰는 ArtifactThumbnail을 그대로 재사용(PNG export
  // 우선·라이브 렌더·placeholder 폴백 — 이 컴포넌트 자신의 no-fiction 규율 그대로 상속, 여기서
  // 새로 흉내내지 않는다).
  if (entityType === 'artifact') {
    const d = detail as { latest_version_number?: number; anchor_version?: number | null };
    if (d.latest_version_number == null) return null;
    return (
      <ArtifactThumbnail
        artifactId={entityId}
        latestVersionNumber={d.latest_version_number}
        anchorVersion={d.anchor_version ?? null}
        className="aspect-video w-full"
      />
    );
  }

  // story #2614 — hypothesis는 풋터(담긴 곳)가 여전히 없다(다대다·getEntityHref 무변경). 하지만
  // statement(§2.2.4 유일한 수동 텍스트 입력)는 story description과 동형으로 몸통에 보일 수
  // 있다 — "풋터에 갈 곳이 없다"와 "몸통에 보여줄 게 없다"는 별개였다는 게 이 스토리의 발견.
  if (entityType === 'hypothesis') {
    const d = detail as { status?: string; statement?: string };
    const statusLabel = d.status ? translateEntityStatus('hypothesis', d.status) : null;
    if (!statusLabel && !d.statement) return null;
    return (
      <div className="space-y-3">
        {statusLabel && (
          <div className="flex flex-wrap gap-1.5">
            <MdBadge label={statusLabel} />
          </div>
        )}
        {d.statement && <MdBody content={d.statement} />}
      </div>
    );
  }

  // story #2780 — 인계 §3/페드루 판정(d8347c43 원칙="빈 모달 여는 거짓 금지"는 유지, 전제만
  // 변화): task/sprint는 여태 RICH_PREVIEW_TYPES 밖이었으나(그때는 보여줄 내용이 없었다)
  // TaskResponse/SprintResponse 실측(backend/app/schemas/task.py·sprint.py) 결과 title·status
  // (+task는 story_id 부모링크·sprint는 start/end_date)가 실제로 있다 — 「있으면 열고 없으면
  // 안 연다」로 이번엔 포함. 필드가 없으면(과거처럼) 여전히 null 반환 — 진입점을 억지로 안 만든다.
  if (entityType === 'task') {
    const d = detail as { title?: string; status?: string; story_id?: string };
    if (!d.title) return null;
    const statusLabel = d.status ? translateEntityStatus('task', d.status) : null;
    const parentHref = d.story_id ? getEntityHref('story', d.story_id) : null;
    if (!statusLabel && !parentHref) return null;
    return (
      <div className="space-y-2">
        {statusLabel && (
          <div className="flex flex-wrap items-center gap-1.5">
            <MdBadge label={statusLabel} />
          </div>
        )}
        {parentHref && (
          <a href={parentHref} className="text-xs text-primary hover:underline">
            부모 스토리 보기 →
          </a>
        )}
      </div>
    );
  }

  if (entityType === 'sprint') {
    const d = detail as { title?: string; status?: string; start_date?: string; end_date?: string };
    if (!d.title) return null;
    const statusLabel = d.status ? translateEntityStatus('sprint', d.status) : null;
    const period = d.start_date && d.end_date ? `${d.start_date} ~ ${d.end_date}` : null;
    if (!statusLabel && !period) return null;
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        {statusLabel && <MdBadge label={statusLabel} />}
        {period && <MdBadge label={period} />}
      </div>
    );
  }

  return null;
}

// story #2889(S2h①③)·S2d(미르코) — gate는 TARGET_ONLY라 renderEntityDetail/RICH_PREVIEW_TYPES
// (parity 대상)엔 안 들어간다. 완전히 독립된 렌더 함수 — 위 renderEntityDetail과 대칭이되 이
// 파일의 parity 계약과 무관(entity-registry.parity.test.ts는 이 함수를 스캔하지 않는다).
// 요약만(제목·상태·risk 배지) — 근거확인/서명/승인 액션은 여기 안 붙인다(approval-request-
// card.tsx가 이미 챗 카드에서 그 몫을 완결하고 있다, 사본 분화 금지 — 이건 "칩 클릭시 훑어보는
// 요약"이지 결재 액션 표면이 아니다).
function renderGateSummary(detail: Record<string, unknown>): React.ReactNode | null {
  const d = detail as {
    gate_type?: string; status?: string; risk_grade?: 'low' | 'high' | 'unknown' | null;
    work_item_summary?: { title: string; slug: string | null } | null; work_item_id?: string;
  };
  if (!d.status && !d.gate_type) return null;
  const statusLabel = d.status ? translateEntityStatus('gate', d.status) : null;
  const title = d.work_item_summary?.title ?? (d.work_item_id ? `#${d.work_item_id.slice(0, 8)}` : null);
  return (
    <div className="space-y-2">
      {title && <p className="text-sm font-medium text-foreground">{title}</p>}
      <div className="flex flex-wrap items-center gap-1.5">
        {d.gate_type && <MdBadge label={d.gate_type} />}
        {statusLabel && <MdBadge label={statusLabel} />}
        {d.risk_grade === 'high' && <MdBadge label="High risk" />}
        {d.risk_grade === 'unknown' && <MdBadge label="Risk unknown" />}
      </div>
    </div>
  );
}

// story #2627 — 결재 카드(chat/approval-request-card.tsx)가 doc 본문 열람을 위해 그대로
// 재사용한다(신규 뷰어 금지·사본 분화 금지, PO 확定). 이전엔 이 파일 내부(EntityChip)만
// 소비하는 비-export 컴포넌트였다 — export만 추가, 내부 로직은 무변경.
export function EntityPreviewModal({
  entityType,
  entityId,
  title,
  status,
  href,
  onClose,
  embedded = false,
}: {
  entityType: string;
  entityId: string;
  title: string | null;
  status: string | null;
  href: string | null;
  onClose: () => void;
  /** story #2766(레인 A) — Dialog(중앙 모달, base DialogContent의 sm:max-w-sm 상속)가 아니라
   * ReadingPanel(우측 패널) 안에 그대로 얹힐 때 true. fetch·헤더·본문·풋터 로직은 완전히
   * 동일 재사용(모달 vs 패널 전환 시 별도 재구현 0) — 바뀌는 건 바깥 래퍼(Dialog vs 패널
   * 자체 크기의 plain div)뿐이다. */
  embedded?: boolean;
}) {
  // story #2302 — hypothesis·evidence는 fetch 자체를 안 한다(항상 고정 ③, ENTITY_API에 항목
  // 없음) — 예전 코드는 'task'만 예외 취급해 loading을 false로 시작했는데, ENTITY_API에 없는
  // 다른 타입(hypothesis·evidence·미등록 타입)은 아래 effect의 `if (!url) return` 이 loading을
  // 영영 false로 안 만들어 **무한 스피너**였다(실측으로 발견 — 이 스토리가 고치기 전까지 잠복
  // 결함). fetch 전략이 있는 타입(doc 특수분기 포함)만 loading=true로 시작한다.
  // story #2889(S2h①③)·S2d(미르코, gate 프리뷰) — gate는 reference_registry의
  // TARGET_ONLY_TYPES라 ENTITY_API/RICH_PREVIEW_TYPES/getEntityHref(전부 entity-registry.
  // parity.test.ts가 BE ENTITY_RESOLVERS와 엄격 대조하는 자리)엔 못 들어간다. 그 계약 밖에서
  // gate 전용 fetch/href/렌더를 독립적으로 붙인다(parity 가드 무영향) — GateSummary(아래)가
  // 유일한 소비 지점.
  const hasFetchStrategy = entityType === 'doc' || entityType === 'gate' || Boolean(ENTITY_API[entityType]);
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
          const previewRes = await fetchWithAuth(`/api/docs/preview?q=${encodeURIComponent(entityId)}`);
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
          const docRes = await fetchWithAuth(`/api/docs?project_id=${docProjectId}&slug=${encodeURIComponent(slug)}`);
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

    if (entityType === 'gate') {
      // gates/[id]/page.tsx·approval-request-card.tsx와 동일 계약(GET /api/gates/{id},
      // {data:GateItem} envelope) — parity 대상 ENTITY_API를 거치지 않는 독립 fetch.
      // fetchWithAuth 필수([[feedback-client-fetch-use-fetchwithauth]]).
      void (async () => {
        try {
          const res = await fetchWithAuth(`/api/gates/${entityId}`);
          if (!res.ok) throw new Error();
          const json = (await res.json()) as { data?: Record<string, unknown> };
          if (!cancelled) setDetail(json.data ?? null);
        } catch {
          if (!cancelled) setNotFound(true);
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
      return () => { cancelled = true; };
    }

    const url = ENTITY_API[entityType]?.(entityId);
    if (!url) return; // hypothesis 등 — fetch 전략 자체가 없다(loading도 이미 false로 시작).
    fetch(url)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((json) => { if (!cancelled) setDetail((json as { data?: Record<string, unknown> }).data ?? json as Record<string, unknown>); })
      .catch(() => { if (!cancelled) setNotFound(true); }) // ㉠ — 조회 실패=대상이 없다(story #2299 still_exists와 같은 원리).
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [entityType, entityId, hasFetchStrategy]);

  // story #2642(PO 08-14, «FE 단독 가능» 조각) — artifact의 부모가 doc이면(via-parent) 그
  // doc이 실제로 속한 project로 직행한다 — #2168이 doc own-href에 이미 증명한 처방(/api/docs/
  // preview 재사용, 새 BE 없음) 그대로 via-parent 경로에도 적용한다. 위 effect가 artifact
  // 자신의 detail(story_id/epic_id/doc_id)을 먼저 채운 *뒤에* doc_id가 있으면 이 effect가
  // 이어 붙는다(체이닝) — docPreview state를 재사용(모달이 열릴 때마다 언마운트→새 인스턴스라
  // 이전 엔티티의 값이 새는 레이스 없음, 위 {showModal && <EntityPreviewModal .../>} 패턴).
  useEffect(() => {
    if (entityType !== 'artifact') return;
    const docId = (detail as { doc_id?: string | null } | null)?.doc_id;
    if (!docId) return;
    let cancelled = false;
    void (async () => {
      try {
        const previewRes = await fetchWithAuth(`/api/docs/preview?q=${encodeURIComponent(docId)}`);
        if (!previewRes.ok) throw new Error();
        const previewJson = (await previewRes.json()) as {
          data?: { slug?: string; projectId?: string; orgSlug?: string; projectSlug?: string | null };
        };
        const slug = previewJson.data?.slug;
        const docProjectId = previewJson.data?.projectId;
        if (!slug || !docProjectId || cancelled) return;
        setDocPreview({
          slug, projectId: docProjectId,
          orgSlug: previewJson.data?.orgSlug ?? '',
          projectSlug: previewJson.data?.projectSlug ?? null,
        });
      } catch {
        // 조용히 실패 — 아래 artifact 분기가 bare `/docs?id=` 폴백으로 떨어진다(④ 원칙,
        // 카드 전체를 안 죽인다 — AC4와 동형).
      }
    })();
    return () => { cancelled = true; };
  }, [entityType, detail]);

  const colorClass = ENTITY_COLORS[entityType] ?? GRAY_STATE_COLOR;
  const label = title ?? entityId;
  // story #2262 AC2(2026-08-08, 쉬운 절반) — 호출부(EntityChip)는 status를 모르고 항상
  // null을 넘긴다(칩 자체는 fetch를 안 하므로). 이 모달은 이미 자기 detail을 fetch하므로
  // (위 effect) 그 안의 status를 물린다 — prop이 실려 오면(EmbedCard 경로처럼 이미 아는
  // 값이 있으면) 그걸 우선한다. 칩 자체(모달 열기 前)에 상태를 보이는 건 별건(PR②,
  // 타입별 배치조회 인프라 필요 — references 사이드밴드엔 status가 없다).
  const resolvedStatus = status ?? (typeof (detail as { status?: unknown } | null)?.status === 'string' ? (detail as { status: string }).status : null);
  // story #2522 — 원시값(raw status enum, 예: "in-review")을 그대로 뱃지에 노출하던 기존
  // gap(#2903 design review 발견). translateEntityStatus로 반드시 통과시킨다 — 맵에 없으면
  // (미매핑 status) null이 나와 뱃지 자체를 안 그린다(원시값 폴백 절대 금지, 빈칸이 정답).
  const resolvedStatusLabel = resolvedStatus ? translateEntityStatus(entityType, resolvedStatus) : null;

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
    // story #2642(BE #3044) — TaskResponse가 이제 org_slug/project_slug를 직접 싣는다(story_id→
    // Story.project_id 1-hop을 BE가 이미 해소해 응답에 얹어 준다 — FE가 또 한 번 조회할 필요 없음).
    const t = detail as { story_id?: string | null; org_slug?: string | null; project_slug?: string | null } | null;
    resolvedHref = resolveScopedEntityHref(
      t?.org_slug ? { orgSlug: t.org_slug, projectSlug: t.project_slug ?? null } : null,
      t?.story_id ? `/board?story=${t.story_id}` : null,
      (ws, proj) => storyBoardUrl(ws, proj, t!.story_id!),
    );
    linkKind = resolvedHref ? 'via-parent' : null;
  } else if (entityType === 'artifact') {
    // 레코드마다 갈린다(story #2302 그라운딩) — story_id/epic_id/doc_id 전부 nullable·최대 1개
    // (hypothesis의 다대다 링크테이블과 다른 모양이라 "하나 고르면 나머지를 숨기는 거짓"이 될
    // 위험이 없다). 우선순위는 story>epic>doc — 동시에 여럿 있을 수 없어(모델 제약은 아니지만
    // 실질적으로 최대 1개라는 그라운딩 전제) 순서 자체가 결과를 바꾸지 않는다.
    // story #2642(BE #3044) — ArtifactResponse는 org_id/project_id가 artifact 자기 행에 이미
    // 있어(생성 시점 _assert_link_target_in_scope로 부모와 같은 org/project 보장) 부모 hop
    // 없이 org_slug/project_slug를 직접 싣는다 — story_id/epic_id 분기 둘 다 이 값을 그대로 쓴다.
    const d = detail as {
      story_id?: string | null; epic_id?: string | null; doc_id?: string | null;
      org_slug?: string | null; project_slug?: string | null;
    } | null;
    const ownerSlugs = d?.org_slug ? { orgSlug: d.org_slug, projectSlug: d.project_slug ?? null } : null;
    // doc 부모만 예외 — docViewUrl은 doc 자신의 slug가 필요한데 artifact 응답엔 그게 없어(위
    // effect가 /api/docs/preview로 별도 선조회한 docPreview를 쓴다, #2168 재사용 그대로).
    const parentHref = d?.story_id
      ? resolveScopedEntityHref(ownerSlugs, `/board?story=${d.story_id}`, (ws, proj) => storyBoardUrl(ws, proj, d.story_id!))
      : d?.epic_id
      ? resolveScopedEntityHref(ownerSlugs, `/goals/${d.epic_id}`, (ws, proj) => goalUrl(ws, proj, d.epic_id!))
      : d?.doc_id
        ? (docPreview && docPreview.orgSlug && docPreview.projectSlug
            ? docViewUrl(docPreview.orgSlug, docPreview.projectSlug, docPreview.slug)
            : `/docs?id=${d.doc_id}`)
        : null;
    resolvedHref = parentHref;
    linkKind = parentHref ? 'via-parent' : null;
  } else if (entityType === 'evidence') {
    // ② — story #2314(2026-07-29): BE GET /{id}가 work_item_type이 story든 task든 이미
    // resolved_story_id 하나로 해소해 준다(task처럼 여기서 또 한 번 join할 필요가 없다).
    // story #2642(BE #3044) — EvidenceResponse가 그 resolve 과정에서 이미 계산해 둔
    // project_id로 org_slug/project_slug도 같이 싣는다(추가 join 없음).
    const ev = detail as { resolved_story_id?: string | null; org_slug?: string | null; project_slug?: string | null } | null;
    resolvedHref = resolveScopedEntityHref(
      ev?.org_slug ? { orgSlug: ev.org_slug, projectSlug: ev.project_slug ?? null } : null,
      ev?.resolved_story_id ? `/board?story=${ev.resolved_story_id}` : null,
      (ws, proj) => storyBoardUrl(ws, proj, ev!.resolved_story_id!),
    );
    linkKind = resolvedHref ? 'via-parent' : null;
  } else if (entityType === 'hypothesis') {
    // ③ 고정 — 위 getEntityHref 주석 참고.
    resolvedHref = null;
    linkKind = null;
  } else if (entityType === 'gate') {
    // gate 상세(/gates/[id])는 story #1954부터 이미 org-scope 플랫 라우트(워크스페이스/
    // 프로젝트 slug 세그먼트 없음, gates/[id]/page.tsx 그대로) — story/epic처럼 슬러그 해소가
    // 필요 없다. getEntityHref의 parity 스위치는 안 거친다(gate는 그 계약 밖).
    resolvedHref = `/gates/${entityId}`;
    linkKind = 'own';
  } else {
    // story·epic·sprint·asset — own-href ①. story #2642(BE #3044)부터 각 detail 응답이
    // org_slug/project_slug를 직접 싣는다 — 엔티티 자신의 project로 직행(뷰어의 현재 프로젝트
    // 추측을 proxy.ts::redirectLegacyResourcePath에 맡기지 않는다). fetch 전/실패(project_slug
    // 없음 포함)는 기존 bare href prop 그대로(④ 원칙, 회귀 아님).
    const own = detail as { org_slug?: string | null; project_slug?: string | null } | null;
    const slugs = own?.org_slug ? { orgSlug: own.org_slug, projectSlug: own.project_slug ?? null } : null;
    const buildScoped =
      entityType === 'story' ? (ws: string, proj: string) => storyBoardUrl(ws, proj, entityId)
      : entityType === 'epic' ? (ws: string, proj: string) => goalUrl(ws, proj, entityId)
      : entityType === 'sprint' ? (ws: string, proj: string) => sprintUrl(ws, proj, entityId)
      : entityType === 'asset' ? (ws: string, proj: string) => assetStorageUrl(ws, proj, entityId)
      : null;
    resolvedHref = buildScoped ? resolveScopedEntityHref(slugs, href, buildScoped) : href;
    linkKind = resolvedHref ? 'own' : null;
  }

  // story #2766(레인 A) — Dialog(모달)와 embedded(패널) 두 래퍼가 헤더/본문/풋터는 100%
  // 동일 재사용한다. embedded일 땐 DialogTitle(base-ui Dialog.Title — Dialog.Root 컨텍스트
  // 밖에서 쓰면 안전하지 않다)을 평범한 span으로 바꾸는 것만 다르다.
  const header = (TitleTag: 'dialog-title' | 'span') => (
    <div className="flex flex-shrink-0 items-start gap-3 border-b border-border px-6 pt-5 pb-3">
      <div className={`flex min-w-0 flex-1 items-center gap-2 rounded-md border px-3 py-1.5 text-sm ${colorClass}`}>
        <EntityGlyph Icon={resolveEntityIcon(entityType)} label={label} />
        {TitleTag === 'dialog-title' ? (
          <DialogTitle className="truncate text-sm font-semibold">{label}</DialogTitle>
        ) : (
          <span className="truncate text-sm font-semibold">{label}</span>
        )}
        {resolvedStatusLabel ? (
          <span className="ml-auto shrink-0 rounded bg-black/10 px-1.5 py-0.5 text-xs dark:bg-white/10">{resolvedStatusLabel}</span>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onClose}
        className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
        aria-label="닫기"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );

  // story #2780 QA(카디르) 발견 — RICH 타입인데 detail에 필요한 필드가 없으면(예: title 없는
  // sprint) EntityDetail이 null을 반환해 몸통이 완전 공백이었다(옛 "미리보기 없음" 문구보다
  // 덜 정직한 새 위반형). "RICH 타입인가"가 아니라 "실제로 보여줄 내용이 있는가"로 이
  // 문구를 하나로 통일한다 — 한 번만 계산해 조건과 렌더 양쪽에 쓴다(이중 호출 금지).
  const richContent = detail && RICH_PREVIEW_TYPES.has(entityType) ? renderEntityDetail(entityType, entityId, detail) : null;
  // gate는 RICH_PREVIEW_TYPES 밖(parity 계약) — richContent와 별개 축으로 계산해 병합.
  const gateSummary = detail && entityType === 'gate' ? renderGateSummary(detail) : null;

  const body = (
    <div className="flex-1 overflow-y-auto px-6 py-4">
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
          불러오는 중…
        </div>
      ) : notFound ? (
        <p className="py-4 text-xs text-muted-foreground">대상을 찾을 수 없습니다.</p>
      ) : richContent !== null ? (
        richContent
      ) : gateSummary !== null ? (
        gateSummary
      ) : (
        <p className="py-4 text-xs text-muted-foreground">이 엔티티는 별도 미리보기가 없습니다.</p>
      )}
    </div>
  );

  // Footer — story #2302 AC4: ㉠/㉡-b는 회색·기본커서로 "죽는 건 링크뿐"(카드 전체 안 죽음).
  // 색은 회색 하나(노랑 금지 — 위 GRAY_STATE_COLOR 주석 참고), 구별은 문구로.
  const footer = !loading && (
    <div className="flex-shrink-0 border-t border-border px-6 py-3">
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
  );

  if (embedded) {
    return (
      <div className="flex h-full flex-col overflow-hidden bg-background">
        {header('span')}
        {body}
        {footer}
      </div>
    );
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="flex max-h-[80vh] max-w-3xl flex-col overflow-hidden rounded-xl p-0" showCloseButton={false}>
        {header('dialog-title')}
        {body}
        {footer}
      </DialogContent>
    </Dialog>
  );
}

export function EmbedCard({
  entity_type, entity_id, title, status, onOpenReadingPanel,
}: EmbedCardData & {
  /** story #2766(레인 A) — 채팅(ChatView)이 물려주면 doc 미리보기 아이콘 클릭이 중앙 모달
   * 대신 우측 ReadingPanel을 연다. 생략하면(undefined, 채팅 밖의 기존 호출부들) 기존
   * Dialog 모달 그대로 — 회귀 없음. */
  onOpenReadingPanel?: (entityType: string, entityId: string, title: string | null, status: string | null, href: string | null) => void;
}) {
  const [showModal, setShowModal] = useState(false);
  const [navigating, setNavigating] = useState(false);
  const router = useRouter();
  const colorClass = ENTITY_COLORS[entity_type] ?? GRAY_STATE_COLOR;
  const href = getEntityHref(entity_type, entity_id);
  const label = title ?? entity_id;
  // story #2522 — EmbedCard 자신의 인라인 카드(모달과 별개 렌더 경로)도 원시값을 그대로
  // 노출하던 같은 클래스의 gap. translateEntityStatus로 통과시킨다(미매핑=null=뱃지 안 그림).
  const statusLabel = status ? translateEntityStatus(entity_type, status) : null;

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
      {statusLabel ? (
        <span className="ml-auto rounded px-1.5 py-0.5 text-xs bg-black/10 dark:bg-white/10">{statusLabel}</span>
      ) : null}
      {navigating && <span className="ml-auto h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />}
    </div>
  );

  // story #2780 — 인계 handoff-entity-embed-reading-panel-2780 §2/§7: 채팅 컨텍스트
  // (onOpenReadingPanel 제공)에서는 «여는 동선»이 타입 무관 하나다 — doc의 기존 이중 버튼
  // (주클릭=이동·eye=미리보기)도 포함해 전부 이 단일 클릭 하나로 합친다(전체 보기는 패널
  // 자신의 명시 액션으로 이동, EntityPreviewModal 풋터 링크가 이미 그 역할). 채팅 밖 호출부
  // (onOpenReadingPanel 미제공 — chat-input.tsx 작성 중 미리보기 등)는 아래 타입별 기존
  // 분기를 그대로 유지(회귀 0).
  if (onOpenReadingPanel) {
    return (
      <button
        type="button"
        onClick={() => onOpenReadingPanel(entity_type, entity_id, title, status, href)}
        className="block w-full text-left transition-opacity hover:opacity-80"
      >
        {inner}
      </button>
    );
  }

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
            {statusLabel ? (
              <span className="shrink-0 rounded px-1.5 py-0.5 text-xs bg-black/10 dark:bg-white/10">{statusLabel}</span>
            ) : null}
            {navigating && <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" />}
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setShowModal(true);
            }}
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

// story #2262 AC1(2026-08-08) — doc `flow-map-blueprint-v1` §2-3 표기 세 조각의 「표면」.
// 스토리 본문의 AC1 정의 그대로: form은 'mention'|'embed'|'proof' 셋뿐(FORMS,
// backend/app/models/reference.py) — 채팅 멘션 파서는 오늘 "mention"만 낸다(다른 값은
// 문서·증빙 경로가 낼 수 있어 표는 셋 다 갖춘다).
const FORM_LABELS: Record<string, string> = { mention: '멘션', embed: '임베드', proof: '근거' };

// 「지점」 — referenced_at(이 참조가 «언제 생겼나»)을 짧게. 블루프린트 예시("7/26 스레드")와
// 같은 월/일 압축 표기 — 채팅 칩은 그 자체가 스레드 맥락이라 별도 "스레드" 접미어를 안 붙인다.
function formatReferencePoint(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // Intl 로케일 포맷("7. 26.")은 블루프린트 예시("7/26")와 안 맞다 — 직접 M/D로 고정한다.
  // UTC 기준(로컬 타임존에 따라 날짜가 하루 밀리는 것을 피한다 — referenced_at은 대략적인
  // 「언제」 지표라 타임존 정밀도가 필요 없다).
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

export function EntityChip({
  entityType,
  entityId,
  label,
  href,
  ghost = false,
  referenceMeta = null,
  entityStatus,
}: {
  entityType: string;
  entityId?: string;
  label: string;
  href: string | null;
  /** story #2263 AC6 — 본문 토큰이 메시지의 stored 참조(읽기 경로 사이드밴드)와 매칭되지
   * 않을 때(=유령 칩, dropped됐거나 손으로 친 토큰). #2302 AC4 규율을 그대로 재사용한다 —
   * 회색 하나(GRAY_STATE_COLOR)·행동 0(클릭·모달 없음)·기본 커서·문구는 이미 선 "대상이
   * 없습니다"(신규 문구 발명 금지). */
  ghost?: boolean;
  /** story #2262 AC1 — 「사실성 · 표면 · 지점」. null이면(유령이거나 references 자체가
   * 없는 경로) 표기하지 않는다 — 모르는 것을 지어내지 않는다(가디언 §H-2와 같은 원칙). */
  referenceMeta?: { form: string; referencedAt: string } | null;
  /** story #2262 AC2 PR② — 배치조회(chat-view.tsx) 결과. 호출부가 안 넘기면(undefined,
   * 배치조회 배선이 없는 기존 호출부 — 예: 과거 테스트) `{kind:'loading'}`으로 안전하게
   * 폴백한다(has-status면 "아직 모름", no-status-concept이면 "상태 없음" — renderEntityStatusLabel이
   * entityType으로 그 둘을 이미 가른다). */
  entityStatus?: EntityStatusFetchState;
}) {
  const [showModal, setShowModal] = useState(false);
  const colorClass = ghost ? GRAY_STATE_COLOR : (ENTITY_COLORS[entityType] ?? GRAY_STATE_COLOR);

  // story #2669(B2) — doc이 chat-view.tsx 배치조회로 draft라고 확認되면, 상신 가능(project
  // write access) 여부를 딱 그 경우에만 추가 조회한다(모든 doc 칩마다 매번 조회하면 N+1 —
  // 대부분의 참조는 이미 confirmed라 draft만 걸러 조회 비용을 줄인다). 승인 직후엔 서버
  // 재조회 없이 이 칩의 로컬 상태만 'pending'으로 넘겨 즉시 반영(배치조회 다음 폴백까지
  // "결재로 올리기"가 다시 뜨는 깜빡임을 막는다).
  const { projectMemberships } = useDashboardContext();
  const [localDocStatus, setLocalDocStatus] = useState<string | null>(null);
  const [canSubmit, setCanSubmit] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(false);
  const rawDocStatus = entityStatus?.kind === 'resolved' ? entityStatus.raw : null;
  const effectiveDocStatus = localDocStatus ?? rawDocStatus;

  useEffect(() => {
    if (entityType !== 'doc' || !entityId || effectiveDocStatus !== 'draft') { setCanSubmit(false); return; }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchWithAuth(`/api/docs/preview?q=${encodeURIComponent(entityId)}`);
        if (!res.ok) throw new Error();
        const json = (await res.json()) as { data?: { projectId?: string } };
        const docProjectId = json.data?.projectId;
        if (!cancelled) setCanSubmit(!!docProjectId && projectMemberships.some((p) => p.projectId === docProjectId));
      } catch {
        if (!cancelled) setCanSubmit(false); // ㉠ 조회 실패=fail-closed(버튼 안 보임), 조용한 무권한 노출 금지.
      }
    })();
    return () => { cancelled = true; };
  }, [entityType, entityId, effectiveDocStatus, projectMemberships]);

  const submitForApproval = async () => {
    if (!entityId || submitting) return;
    setSubmitting(true);
    setSubmitError(false);
    try {
      const res = await fetch(`/api/docs/${entityId}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'pending' }),
      });
      if (!res.ok) throw new Error();
      setLocalDocStatus('pending');
    } catch {
      setSubmitError(true);
    } finally {
      setSubmitting(false);
    }
  };

  const statusLabel = ghost ? null : renderEntityStatusLabel(entityType, localDocStatus ? { kind: 'resolved', raw: localDocStatus } : (entityStatus ?? { kind: 'loading' }));

  const inner = (
    <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs font-medium ${colorClass}`}>
      <EntityGlyph Icon={resolveEntityIcon(entityType)} label={label} className="size-3 shrink-0" />
      <span>{ghost ? '대상이 없습니다' : label}</span>
      {/* AC1 — 사실성(상수 "관찰됨": entity_references 자체가 관찰됨 tier) · 표면 · 지점.
          ⛔색으로만 구분하지 않고 글자로 적는다(가디언 규율 재사용). */}
      {referenceMeta ? (
        <span className="opacity-70">
          · 관찰됨 · {FORM_LABELS[referenceMeta.form] ?? referenceMeta.form} · {formatReferencePoint(referenceMeta.referencedAt)}
        </span>
      ) : null}
      {statusLabel ? <span className="opacity-70">· {statusLabel}</span> : null}
    </span>
  );

  if (ghost) {
    return <span className="inline-flex cursor-default no-underline">{inner}</span>;
  }

  if (entityId) {
    // story #2669(B2) — "쓰던 자리에 이미 있어야 한다": 모달을 열지 않고도 칩 자체에 상태별
    // CTA가 상시 붙는다. draft=상신 가능자에게만 「결재로 올리기」(fail-closed) · pending=
    // 「결재함에서 보기」 딥링크. confirmed/denied는 위 statusLabel 배지로 이미 정직하게 표시.
    const docCta = entityType === 'doc' && !ghost ? (
      effectiveDocStatus === 'draft' && canSubmit ? (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); void submitForApproval(); }}
          disabled={submitting}
          className="inline-flex shrink-0 items-center rounded border border-primary/40 px-1.5 py-0.5 text-xs font-medium text-primary no-underline hover:bg-primary/10 disabled:opacity-60"
        >
          {submitting ? '...' : '결재로 올리기'}
        </button>
      ) : effectiveDocStatus === 'pending' ? (
        <Link
          href="/inbox?tab=gates"
          onClick={(e) => e.stopPropagation()}
          className="inline-flex shrink-0 items-center rounded border border-border px-1.5 py-0.5 text-xs font-medium text-muted-foreground no-underline hover:bg-muted"
        >
          결재함에서 보기
        </Link>
      ) : null
    ) : null;
    return (
      <span className="inline-flex flex-wrap items-center gap-1">
        <button
          type="button"
          onClick={() => setShowModal(true)}
          className="inline-flex no-underline transition-opacity hover:opacity-80"
        >
          {inner}
        </button>
        {docCta}
        {submitError ? <span className="text-xs text-destructive">상신 실패, 다시 시도해 주세요</span> : null}
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
      </span>
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
