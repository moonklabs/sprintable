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
