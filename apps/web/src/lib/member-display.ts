// story #3755(BE·표시명·결함 클래스, 페드루 PO 決 2026-09-09) — BE resolver가 display_name
// 없는 휴먼 구성원을 이메일/id 문자열로 지어내는 대신 정직하게 name: null을 돌리도록 고친
// 뒤(member_resolver.py 5자리), FE 소비처(활동 로그 actor·대화 참여자·이벤트 발행 이력
// sender)가 그 null을 각자 다르게 다루던 것(대개 조용히 빈 칸/생략)을 한 헬퍼로 수렴한다.
// channel-label.ts의 (value, t) 시그니처와 동형 — 새 기전 발명 금지.
export function memberDisplayLabel(name: string | null | undefined, t: (key: string) => string): string {
  return name ?? t('memberUnnamed');
}
