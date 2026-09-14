/**
 * story #3880(§⑤ 낱말 드리프트) CHANGES ④(PO PR 코멘트, 2026-09-14 16:13Z) — 「순 ASCII
 * 단어/구」 술어를 가드 3곳(verify-no-raw-ascii-jsx-text.ts §3876·verify-no-raw-ascii-jsx-attr.ts
 * §3880(a)·verify-no-ascii-token-in-ko-value.ts §3880(b) whole-value 축)이 각자 다른
 * 정규식(`^[A-Za-z][A-Za-z0-9]*(?:[ '-][A-Za-z0-9]+)*$`)으로 근사해 구두점(…·—) 하나만
 * 섞여도 못 잡는 클래스를 공유 구현 하나로 봉쇄한다(실 사고: page-embed-node.tsx의
 * "Enter document slug or ID…"·"Loading document…"·"Circular embed detected — a
 * document cannot embed itself." — 전부 …/— 때문에 옛 정규식을 통과했다).
 *
 * ## 판정 — 3조건(PO 명시, 그대로 구현)
 * 트림한 문자열이 (1) 한글·CJK 0자 AND (2) 영문 단어(연속 알파벳 2자+) 1개 이상 AND
 * (3) 나머지 문자가 전부 공백·숫자·허용 구두점(…·–—- 포함)뿐 — 이면 "미번역 카피".
 *
 * ⚠️이 술어가 «못 잡는» 것: 한글이 조금이라도 섞인 문자열(예: "이 문서는 draft
 * 상태입니다") — 이건 다른 클래스(한글 문장 안에 낱말 하나가 미번역, verify-no-ascii-
 * token-in-ko-value.ts의 CAPS 토큰 축과 인접하나 소문자 낱말까지는 그 축도 안 봄) — 별도
 * 축(story #3880 스코프 밖, PO 판단 대상).
 *
 * ⚠️구두점 집합 좁힘 근거(실측) — 1차 구현이 `&%$#@+=<>()[]{}/`까지 필러로 허용해
 * 이메일 주소(legal@moonklabs.com)·URL 조각(sprintable.app/)·HTML 엔티티(&ldquo;)·
 * 해시 조각(PR #) 등 «자연어 문장이 아닌 기술 토큰»까지 대거 오탐을 낸 것을
 * `--write-baseline` 드라이런 실측으로 적발 — 문장부호(마침표·쉼표·물음표·느낌표·
 * 콜론·세미콜론·따옴표·하이픈)만 남기고 걷어냄.
 */

const HANGUL_CJK_RE = /[가-힣ᄀ-ᇿ㄰-㆏㐀-䶿一-鿿豈-﫿]/;
const ENGLISH_WORD_RE = /[A-Za-z]{2,}/;
const ENGLISH_LETTER_RUN_RE = /[A-Za-z]+/g;
const FILLER_ONLY_RE = /^[\s0-9…·–—\-'".,:;!?]*$/;

export function isUntranslatedCopy(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (HANGUL_CJK_RE.test(trimmed)) return false;
  if (!ENGLISH_WORD_RE.test(trimmed)) return false;
  const withoutWords = trimmed.replace(ENGLISH_LETTER_RUN_RE, '');
  return FILLER_ONLY_RE.test(withoutWords);
}
