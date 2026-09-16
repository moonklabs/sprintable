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

/**
 * story #3328(PO 리뷰, 2026-09-02) — BE `reference_token.py::_escape_title`가 라벨 안의
 * `\ [ ] ( )`를 `\`-escape해 저장한다(마크다운 링크 문법과 라벨 원문의 대괄호/괄호가 섞이지
 * 않도록). 이 escape를 원복하는 규칙은 원래 chat-report-density.ts(story #3080)의
 * stripInlineMarkers 안에 한 곳뿐이었다 — SSOT로 여기에 옮겨 재사용(두 벌 유지 금지).
 * `\X` → `X`(백슬래시만 제거, 이스케이프된 문자 자체는 보존) — 원문 라벨 그대로, 문법
 * 기호만 벗긴다(no-fiction).
 */
export function unescapeReferenceLabel(label: string): string {
  return label.replace(/\\(.)/g, '$1');
}

/**
 * story #3949(E-UX-OVERHAUL·customer-zero·§①) — 3888(대화 목록 미리보기 raw 키)·
 * 3903/3940(알림 요약 raw 키)과 같은 「본문 렌더러는 고쳤는데 요약 소비처는 원문」
 * 클래스의 3번째: 마크다운 링크/entity 참조 토큰이 든 «보통» 메시지가 미리보기·요약
 * 자리(본문 렌더러를 안 거치는 곳)에서 원문 그대로 샌다.
 *
 * 마크다운 링크 `[라벨](href)` 전부(entity: 스킴이든 일반 URL이든 — href 값은 미리보기
 * 자리에서 어차피 안 쓰인다) → 라벨만 남긴다. entity 참조 토큰도 결국 이 문법의 한
 * 사례라 별도 분기가 필요 없다 — `unescapeReferenceLabel`(story #3328 SSOT)로 라벨
 * 안의 `\[`/`\]` 이스케이프까지 원복한다. 본문 칩 렌더(EntityChip·parseEntityRef)는
 * 무변 — 이 함수는 "칩을 못 그리는" 평문 전용 자리에만 쓴다(no-fiction: 원문 라벨
 * 그대로, 문법 기호만 벗김·리라이트 0).
 */
export function toPlainPreview(content: string): string {
  return content
    .replace(/\[((?:\\.|[^[\]\\])*)\]\([^)]*\)/g, (_m, label: string) => unescapeReferenceLabel(label))
    .trim();
}
