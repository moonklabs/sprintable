/**
 * story #2888(S2a) — entity ref 파싱 SSOT. 이전엔 이 정규식이 chat-bubble.tsx(×2 — `p`·`a`
 * 컴포넌트 각자)·embed-card.tsx(`MDBODY_ENTITY_REF_RE`)·doc-content-renderer.tsx
 * (`ENTITY_REF_RE`)에 문자 그대로 3중 복제돼 있었다(드리프트 위험) — 이 파일 하나로 수렴한다.
 *
 * 본문 entity 참조 토큰 `[제목](entity:타입:id)`의 href 매칭 — id는 UUID만(비-UUID는
 * 매칭 실패 → 호출부가 평문 링크로 폴백, 엔티티 칩/카드 미렌더).
 */
const ENTITY_REF_RE = /^entity:(\w+):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export interface ParsedEntityRef {
  entityType: string;
  entityId: string;
}

export function parseEntityRef(href: string | null | undefined): ParsedEntityRef | null {
  const m = href?.match(ENTITY_REF_RE);
  if (!m) return null;
  return { entityType: m[1]!, entityId: m[2]! };
}
