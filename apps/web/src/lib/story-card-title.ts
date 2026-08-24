/**
 * story #32dcc294(v2 #2, 시안 a230cfd5) — 보드 스토리 카드 제목 파싱. 3015(brief-lead) 규율과
 * 동일: verbatim만, 리라이트·요약 생성 절대 금지. 선두 `[태그]` 하나만 카테고리 칩으로 분리하고
 * 나머지 원문은 그대로 반환한다(소스 story.title 자체는 무변경 — 표현 층 전용 변환).
 */

const LEADING_TAG_RE = /^\[([^\]]+)\]\s*/;

export interface ParsedStoryCardTitle {
  categoryTag: string | null;
  lead: string;
}

export function parseStoryCardTitle(rawTitle: string): ParsedStoryCardTitle {
  const trimmed = rawTitle.trim();
  const match = trimmed.match(LEADING_TAG_RE);
  if (!match) return { categoryTag: null, lead: trimmed };

  const categoryTag = match[1]!.trim();
  const lead = trimmed.slice(match[0].length).trim();
  // 태그만 있고 남는 제목이 없으면(엣지) 원문을 훼손하지 않고 전체를 lead로 폴백한다
  // (빈 제목 방지 — verbatim 가드).
  if (!lead) return { categoryTag: null, lead: trimmed };
  return { categoryTag, lead };
}
