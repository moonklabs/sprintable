/**
 * story #178c7c6d(3015 시안 ②, 아티팩트 0b6fddba) — Workcell Brief 표현 층 변환.
 * 소스(story.description/acceptance_criteria)는 무변경 — 이 함수는 렌더 시점 표현
 * 변환만 한다. 리라이트·요약 생성 절대 금지(no-fiction) — 스트립 결과는 항상 원문 verbatim.
 */

// 카디르 QA(#3445) MEDIUM 적출 — 헤딩 마커 뒤에 공백이 하나도 없이 줄/문자열이 그대로 끝나는
// 경우(예: 원문 전체가 "## " 하나뿐, 바깥 trim()이 그 유일한 공백마저 먹어 "##"만 남음)도
// 헤딩으로 인식해야 마커가 리드에 새지 않는다 — 공백(\s)뿐 아니라 줄/문자열 끝($)도 허용.
const FIRST_HEADING_RE = /^#{1,6}(?=\s|$)/m;

function stripInlineMarkdown(text: string): string {
  return text
    // 구조 마커(줄 앞)부터 먼저 걷는다 — 리스트 불릿 `*`/`+`가 뒤이은 인라인 강조(*..*)
    // 파싱과 충돌하지 않도록 순서를 고정한다(불릿은 마커+공백, 강조는 마커+공백없음이라
    // 아래 정규식들이 서로 오탐하지 않는다).
    .replace(/^[ \t]*>[ \t]?/gm, '') // 인용 마커(>)
    .replace(/^[ \t]*[-*+][ \t]+(?:\[[ xX]\][ \t]+)?/gm, '') // 리스트 마커(-,*,+, task-list 체크박스 포함)
    .replace(/^[ \t]*\d+[.)][ \t]+/gm, '') // 순서 리스트 마커(1. 또는 1))
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // ![alt](url) -> alt(이미지, 링크보다 먼저 — 안 그러면 '!' 잔존)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // [label](url) -> label
    .replace(/`([^`]*)`/g, '$1') // `code` -> code
    .replace(/\*\*([^*]+)\*\*/g, '$1') // **bold** -> bold(단일 별표 강조보다 먼저)
    .replace(/\*([^*\n]+)\*/g, '$1') // *italic* -> italic
    .replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/g, '$1') // _italic_ -> italic(단어 경계 필수 — snake_case 오파괴 방지)
    .trim();
}

/**
 * 첫 `## ` 헤딩 앞의 프로즈를 리드로 추출 후 인라인 마크다운 기호를 스트립한다. 헤딩이
 * 텍스트 없이 비어 있으면(예: 「##   \n본문」) 그 헤딩을 건너뛰고 다음 내용에서 계속
 * 찾는다 — 순수 마커만 리드로 노출되는 사고(카디르 QA #3445 적출)를 막는다. 전체가 빈
 * 헤딩들로만 채워져 있으면 그제서야 정직하게 빈 문자열을 반환한다(지어내지 않음).
 */
export function extractBriefLead(raw: string): string {
  let remaining = raw.trim();

  while (remaining) {
    const headingMatch = remaining.match(FIRST_HEADING_RE);
    const rawLead = headingMatch ? remaining.slice(0, headingMatch.index) : remaining;
    const lead = stripInlineMarkdown(rawLead);
    if (lead) return lead;
    if (!headingMatch) return '';

    const headingStart = headingMatch.index ?? 0;
    const headingLineEnd = remaining.indexOf('\n', headingStart);
    const headingLine = remaining.slice(headingStart, headingLineEnd === -1 ? undefined : headingLineEnd);
    const headingText = stripInlineMarkdown(headingLine.replace(/^#{1,6}[ \t]*/, ''));
    if (headingText) return headingText;

    // 헤딩 줄 자체도 텍스트가 없다(순수 마커만) — 이 줄을 건너뛰고 그 다음 내용으로 계속.
    remaining = headingLineEnd === -1 ? '' : remaining.slice(headingLineEnd + 1).trim();
  }

  return '';
}
