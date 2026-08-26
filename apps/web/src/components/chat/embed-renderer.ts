import type { ChatMessage } from '@/hooks/use-chat-sse';

/**
 * story #2888(S2a) — 임베드 렌더 결정 트리 SSOT("EmbedRenderer"). 이전엔 chat-bubble.tsx의
 * `p`(sole-link)·`a`(inline) 두 react-markdown 컴포넌트가 각자 asset 체크·유령 체크·
 * referenceMeta 조회를 따로 인라인으로 짜고 있었다 — 이 파일 하나로 수렴한다.
 *
 * 두 호출부는 데이터 형태(`node`+`children` vs `href`+`children`)가 달라 단일 컴포넌트로
 * 합칠 수 없지만(react-markdown 슬롯 시그니처가 다름), **결정 로직**(무엇을 렌더할지)은
 * 이 순수 함수 하나로 합쳐 두 곳이 똑같이 호출한다.
 *
 * embed-card.tsx(mdBody)·doc-content-renderer.tsx는 `references` 사이드밴드가 아예 없는
 * 컨텍스트(엔티티 본문 안에 중첩된 참조·doc 페이지 본문)라 `allowCard: false`·
 * `references: undefined`로 호출한다 — `isGhostReference(undefined,...)`가 `false`를
 * 반환하는 기존 계약(references 부재 = "모른다", "유령"이 아니다) 그대로 asset|chip 2갈래로
 * 자연히 좁혀진다(기존 동작과 값으로 동일 — 두 파일 다 ghost/referenceMeta를 원래도 안 썼다).
 */

// story #2263 AC6 — 본문 토큰(target_type+target_id)이 메시지의 stored 참조 목록에 있는지
// 대조한다. `references === undefined`(옛 서버·SSE 디스패치 등 이 필드를 안 주는 경로)는
// 판단 재료가 없다는 뜻이라 유령 처리를 보류한다(폴백 — 기존처럼 그대로 그린다). 대소문자
// 차이(사용자가 UUID를 대문자로 쳐 넣는 경우)를 흡수하려 양쪽 다 lower-case로 비교한다.
export function isGhostReference(
  references: ChatMessage['references'],
  targetType: string,
  targetId: string,
): boolean {
  if (references === undefined) return false;
  const type = targetType.toLowerCase();
  const id = targetId.toLowerCase();
  return !references.some((r) => r.target_type.toLowerCase() === type && r.target_id.toLowerCase() === id);
}

// story #2262 AC1(2026-08-08) — doc `flow-map-blueprint-v1` §2-3 「사실성 · 표면 · 지점」의
// «표면·지점» 재료. isGhostReference와 같은 대조를 한 번 더 해 form·referenced_at까지
// 끌어온다(스토리 자신의 AC1 정의: 표면=form('mention'|'embed'|'proof'), 지점=referenced_at —
// "이 참조가 «언제 생겼나»"이지 대상이 「언제 만들어졌나」가 아니다). 매칭 없으면(유령이거나
// references 자체가 없으면) null — 그때는 칩에 표기하지 않는다(모르는 것을 지어내지 않는다).
export function findReferenceMeta(
  references: ChatMessage['references'],
  targetType: string,
  targetId: string,
): { form: string; referencedAt: string } | null {
  if (!references) return null;
  const type = targetType.toLowerCase();
  const id = targetId.toLowerCase();
  const match = references.find((r) => r.target_type.toLowerCase() === type && r.target_id.toLowerCase() === id);
  if (!match || !match.form || !match.referenced_at) return null;
  return { form: match.form, referencedAt: match.referenced_at };
}

export type EmbedDecision =
  | { kind: 'asset' }
  | { kind: 'card' }
  | { kind: 'chip'; ghost: boolean; referenceMeta: { form: string; referencedAt: string } | null };

/**
 * 결정 트리(AC2): asset→'asset'(AssetEmbedCard) / sole-link(& allowCard·비유령)→'card'
 * (EmbedCard) / 그 외 인라인→'chip'(EntityChip, ghost·referenceMeta 동봉).
 *
 * `allowCard`는 호출부(그 슬롯이 "문단 전체가 링크 하나뿐"인지)가 이미 판정해 넘긴다 —
 * 이 함수 자신은 그 판정을 하지 않는다(soleLinkChild는 hast AST가 필요해 chat-bubble의
 * `p` 컴포넌트 스코프에만 있다).
 */
export function resolveEmbedDecision(
  entityType: string,
  entityId: string,
  references: ChatMessage['references'],
  opts: { allowCard: boolean },
): EmbedDecision {
  if (entityType.toLowerCase() === 'asset') return { kind: 'asset' };
  const ghost = isGhostReference(references, entityType, entityId);
  if (opts.allowCard && !ghost) return { kind: 'card' };
  const referenceMeta = ghost ? null : findReferenceMeta(references, entityType, entityId);
  return { kind: 'chip', ghost, referenceMeta };
}
