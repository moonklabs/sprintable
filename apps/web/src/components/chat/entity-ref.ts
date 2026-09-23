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

// 코드(펜스·인라인) 안의 리터럴 `<!--`는 주석이 아니다 — 코드를 먼저 통째로 매치해 그대로
// 두고 코드 밖 주석만 지운다(서버 text_preview.strip_html_comments와 같은 규칙, PR #4541
// 까디르 QA: 코드 속 `<!--`가 뒷본문을 전부 삼키던 회귀).
const CODE_OR_HTML_COMMENT_RE = /(```[\s\S]*?```|`[^`\n]*`)|<!--[\s\S]*?(?:-->|$)/g;

/**
 * story #4197 — 내부 HTML 주석(`<!-- linear-comment-id … -->` 등 외부 동기화가 심는 비가시 마커)만 걷어낸다.
 * 코드 펜스·인라인 코드 안의 리터럴 `<!--`는 그대로 둔다(위 정규식이 코드를 먼저 통째로 매치). 닫히지 않은
 * `<!--`는 끝까지 주석으로 본다(HTML 규칙과 같다). 줄바꿈·그 밖의 본문은 건드리지 않아 마크다운 렌더 전에
 * 써도 된다 — 채팅 말풍선 본문(chat-bubble ChatMarkdown)과 아래 toPlainPreview가 같은 규칙을 쓴다.
 */
export function stripHtmlComments(content: string): string {
  return content.replace(CODE_OR_HTML_COMMENT_RE, (_m, code: string | undefined) => code ?? '');
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
 *
 * PO CHANGES 1회차(2026-09-16 11:42Z) C1 — 마크다운 이미지 `![alt](url)`도 같은 클래스
 * (문법 기호가 평문 자리에 샘)라 선행 `!` 1글자까지 같이 벗긴다(`!?` — 있으면 소비,
 * 없으면 기존 링크 동작 그대로).
 *
 * story #4182(산티아고 prod 에스컬레이션 aca44e0d) — 같은 클래스의 4번째: 내부 HTML
 * 주석(`<!-- linear-comment-id … -->` 등, 외부 동기화가 본문 앞에 심는 비가시 메타데이터
 * 마커)이 마크다운 링크가 아니라서 위 치환을 그냥 통과해 미리보기에 원문 그대로 샜다.
 * HTML 주석은 여기서 통째로 제거한다(`[\s\S]*?` — 개행 포함 비탐욕 매치, 여러 개면
 * 전부). 렌더 시점 전용 처리(저장 데이터 이관 0), 본문 칩 렌더는 무변.
 *
 * PO CHANGES(페드루, 2026-09-23) — 백링크·스토리 출처 섹션이 쓰는 `content_snippet`은
 * 서버 `build_content_snippet`(backend/app/services/backlinks.py:205, 160자+ellipsis)이
 * 이미 잘라서 준다. 긴 주석이 절삭 지점에 걸리면 `<!-- linear-comment-id: f4…`처럼
 * `-->`가 아예 안 남아 위 정규식이 못 잡는다 — 닫히지 않은 `<!--`는 문자열 끝까지
 * 제거한다(`(?:-->|$)`).
 */
export function toPlainPreview(content: string): string {
  return stripHtmlComments(content)
    .replace(/!?\[((?:\\.|[^[\]\\])*)\]\([^)]*\)/g, (_m, label: string) => unescapeReferenceLabel(label))
    .trim();
}
