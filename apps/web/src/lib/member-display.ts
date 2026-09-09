// story #3755(BE·표시명·결함 클래스, 페드루 PO 決 2026-09-09) — BE resolver가 display_name
// 없는 휴먼 구성원을 이메일/id 문자열로 지어내는 대신 정직하게 name: null을 돌리도록 고친
// 뒤(member_resolver.py 5자리), FE 소비처가 그 null을 각자 다르게 다루던 것(같은 사실이
// 화면마다 다른 낱말로 뜨거나, 조용히 빈 칸으로 사라지던 것)을 한 헬퍼로 수렴한다.
// channel-label.ts의 (value, t) 시그니처와 동형 — 새 기전 발명 금지. 실 소비처(2026-09-09
// 기준): activity-log-view.tsx·dashboard-activity-timeline.tsx(활동 로그 actor) ·
// organization/events/page.tsx(이벤트 발행 이력 sender). 대화 참여자 화면은 이미 story
// #3203/#3679가 「알 수 없는 멤버」로 별도 수렴해 둔 상태라 이 헬퍼를 안 쓴다(중복 수렴
// 아님 — 그 화면은 이 결함 클래스의 영향을 받은 적이 없었다, PR #4105 델타 참고).
//
// 유나 디자인 게이트 적기만②(2026-09-09) — `??`는 null/undefined만 잡고 빈 문자열은
// 그대로 통과시킨다. BE가 ""를 name으로 준 적은 실측 0건이지만(전부 None 아니면 실
// 문자열), 방어적으로 빈 문자열도 같은 폴백으로 묶는다 — "" 도 "이름 없음"과 같은 사실
// (표시할 이름이 없다)이라 다른 취급을 둘 이유가 없다.
export function memberDisplayLabel(name: string | null | undefined, t: (key: string) => string): string {
  return name ? name : t('memberUnnamed');
}
