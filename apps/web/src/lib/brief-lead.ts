/**
 * story #178c7c6d(3015 시안 ②, 아티팩트 0b6fddba) — Workcell Brief 표현 층 변환.
 * 소스(story.description/acceptance_criteria)는 무변경 — 이 함수는 렌더 시점 표현
 * 변환만 한다. 리라이트·요약 생성 절대 금지(no-fiction) — 스트립 결과는 항상 원문 verbatim.
 */

const FIRST_HEADING_RE = /^#{1,6}[ \t]+/m;

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // [label](url) -> label
    .replace(/`([^`]*)`/g, '$1') // `code` -> code
    .replace(/^[ \t]*[-*][ \t]+/gm, '') // 리스트 대시/별표 마커
    .replace(/^[ \t]*\d+\.[ \t]+/gm, '') // 순서 리스트 마커
    .trim();
}

/**
 * 첫 `## ` 헤딩 앞의 프로즈를 리드로 추출 후 인라인 마크다운 기호를 스트립한다.
 * 전체가 헤딩으로 시작해 리드가 비면(예: 「# 제목\n...」), 그 헤딩 텍스트 자체를
 * 폴백으로 쓴다(빈 Brief 방지 — 지어내지 않고 실제 헤딩 텍스트를 그대로 노출).
 */
export function extractBriefLead(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';

  const headingMatch = trimmed.match(FIRST_HEADING_RE);
  const rawLead = headingMatch ? trimmed.slice(0, headingMatch.index) : trimmed;
  const lead = stripInlineMarkdown(rawLead);
  if (lead || !headingMatch) return lead;

  const headingStart = headingMatch.index ?? 0;
  const headingLineEnd = trimmed.indexOf('\n', headingStart);
  const headingLine = trimmed.slice(headingStart, headingLineEnd === -1 ? undefined : headingLineEnd);
  return stripInlineMarkdown(headingLine.replace(/^#{1,6}[ \t]+/, ''));
}
