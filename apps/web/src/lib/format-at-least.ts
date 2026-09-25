/**
 * story #4302(유나 판정) — 페이지로 나눠 받는 목록의 «불러온 수»는 전체가 아니다. 더 남았을 때(hasMore · 다음 커서)는 숫자 바로 뒤에 `+`를
 * 붙여 한계를 드러내고, 다 불러왔으면 맨 수. 서버가 전체 수를 주는 자리는 이 헬퍼 대신 그 수를 쓴다.
 * «이상» 대신 `+`인 이유: 뱃지 · 괄호 · 좁은 폭 어디에나 들어가는 한 규칙이라서(단위 낱말은 호출부 문구 그대로).
 * 복수형 ICU 키(en `{count, plural, …}`)에는 이 문자열을 넘기지 말 것 — 숫자가 아니라 plural이 깨진다. 그런 자리는 `+`를 품은 형제 키를 쓴다
 * (예: storage.summaryAtLeast).
 */
export function formatAtLeast(count: number, hasMore: boolean): string {
  return hasMore ? `${count}+` : String(count);
}
