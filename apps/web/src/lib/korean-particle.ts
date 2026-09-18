// story #3698(IA·후속) — 커맨드 팔레트가 nav 라벨을 "{label}(으)로 이동" 문구에 동적으로
// 끼워 넣으면서 드러난 문제: 「알림」(받침 있음→으로)과 「보드」(받침 없음→로)가 같은
// 고정 조사를 못 쓴다(회귀가드 command-palette.test.tsx가 "알림으로 이동"을 기대해
// 실측으로 잡았다). 낱말별로 손으로 문구를 짓던 예전 방식(goInbox="알림으로 이동" 등)은
// 조사가 항상 맞았지만 그건 "미리 다 쓴 문장"이었지 "동적으로 낱말을 끼워 넣는" 게
// 아니었다 — nav-config가 늘어날 때마다 사람이 조사를 손으로 맞출 순 없다.
//
// 이건 디자인/어휘 판단이 아니라 한글 맞춤법의 기계적 규칙(받침 유무)이라 유나 § 없이
// 결정적 함수로 푼다 — 완성형 한글 음절(U+AC00~U+D7A3)의 유니코드 분해 공식은 표준이고
// 예외가 없다(모든 완성형 음절에 항상 유일한 정답이 있다).
const HANGUL_BASE = 0xac00;
const HANGUL_LAST = 0xd7a3;
const JONGSEONG_COUNT = 28;
// 종성 인덱스 8 = ㄹ(KS X 1001 표준 순서: 0=받침없음, 1=ㄱ, ... 8=ㄹ, ...).
const RIEUL_JONGSEONG_INDEX = 8;

function lastHangulChar(word: string): string | null {
  const trimmed = word.trim();
  for (let i = trimmed.length - 1; i >= 0; i -= 1) {
    const code = trimmed.codePointAt(i)!;
    if (code >= HANGUL_BASE && code <= HANGUL_LAST) return trimmed[i]!;
  }
  return null;
}

/** "으로"/"로" 중 word 뒤에 맞는 조사. 완성형 한글이 아니면(영문·숫자 등) 받침 없는 것과
 * 동일하게 "로"를 반환한다(원문 그대로 폴백 — channel-label.ts류 관례와 동형, 지어내지
 * 않는다는 원칙을 "모르면 안전한 쪽"으로 적용). */
export function pickEuroJosa(word: string): '으로' | '로' {
  const ch = lastHangulChar(word);
  if (ch === null) return '로';
  const offset = ch.codePointAt(0)! - HANGUL_BASE;
  const jongseong = offset % JONGSEONG_COUNT;
  if (jongseong === 0 || jongseong === RIEUL_JONGSEONG_INDEX) return '로';
  return '으로';
}

// story #3824(UX-v3·FE 1, 2026-09-13) — more/page.tsx의 moreTabHint가 "{chats}은"으로
// 조사를 문자열에 고정해 두었다가 nav.chats 값이 "채팅"(받침 있음)→"대화"(받침 없음)로
// 바뀌며 "대화은"이라는 비문이 됐다(카드 테스트 실측으로 발견) — pickEuroJosa와 동일한
// 근거(완성형 한글 종성 유무는 예외 없는 기계적 규칙)로 「은/는」도 결정적 함수로 푼다.
export function pickEunNeunJosa(word: string): '은' | '는' {
  const ch = lastHangulChar(word);
  if (ch === null) return '는';
  const offset = ch.codePointAt(0)! - HANGUL_BASE;
  const jongseong = offset % JONGSEONG_COUNT;
  return jongseong === 0 ? '는' : '은';
}

// story #3900(UX-v3·§⑤ 어조 가드 사각 3) — 플레이스홀더 뒤 「{name}이/가」·「{title}을/를」을
// 문자열에 고정해 둔 자리(값의 받침 유무에 따라 비문이 되는 자리)를 pickEuroJosa·pickEunNeunJosa와
// 동일한 근거(완성형 한글 종성 유무=예외 없는 기계적 규칙)로 결정적 함수로 푼다. 「이/가」·「을/를」은
// 「은/는」과 같은 규칙(받침 有→이/을·받침 無→가/를 — ㄹ 예외 없음). 비한글(숫자·영문)은 받침 없는
// 쪽으로 폴백(안전한 쪽·pickEunNeunJosa 관례와 동형) — 숫자 읽기 받침이 문제되는 자리는 조사 회피로
// 문장을 재구성한다(§⑤ 3900 ③ 표).
export function pickIGaJosa(word: string): '이' | '가' {
  const ch = lastHangulChar(word);
  if (ch === null) return '가';
  const offset = ch.codePointAt(0)! - HANGUL_BASE;
  const jongseong = offset % JONGSEONG_COUNT;
  return jongseong === 0 ? '가' : '이';
}

export function pickEulReulJosa(word: string): '을' | '를' {
  const ch = lastHangulChar(word);
  if (ch === null) return '를';
  const offset = ch.codePointAt(0)! - HANGUL_BASE;
  const jongseong = offset % JONGSEONG_COUNT;
  return jongseong === 0 ? '를' : '을';
}
