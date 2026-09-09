// story #3755(BE·표시명·결함 클래스, 페드루 PO 決 2026-09-09) — BE resolver가 display_name
// 없는 휴먼 구성원을 이메일/id 문자열로 지어내는 대신 정직하게 name: null을 돌리도록 고친
// 뒤(member_resolver.py 5자리), FE 소비처가 그 null을 각자 다르게 다루던 것(같은 사실이
// 화면마다 다른 낱말로 뜨거나, 조용히 빈 칸으로 사라지던 것)을 한 헬퍼로 수렴한다.
// channel-label.ts의 (value, t) 시그니처와 동형 — 새 기전 발명 금지. 실 소비처(2026-09-09
// 기준): activity-log-view.tsx·dashboard-activity-timeline.tsx(활동 로그 actor) ·
// organization/events/page.tsx(이벤트 발행 이력 sender).
//
// 대화 참여자 화면(chats/[conversation_id]/page.tsx)은 이 헬퍼를 **안 쓰는게 아니라 못
// 쓴다**(유나 디자인 게이트 정정, 2026-09-09) — 정정: 그 화면도 이 결함 클래스의 영향을
// 실제로 받았다(conversations.py:398이 이 PR이 고친 lookup_members_by_ids를 그대로 쓰고
// :417 name=resolved.name으로 흘려보낸다). 다만 참여자 응답 payload가 「실존 구성원인데
// display_name만 없음」과 「orphan(member/alias 자체가 없음)」 둘 다 name=None으로 채우고
// 그 둘을 가르는 필드가 없다(member_resolver.py의 orphan-fallback과 실존-무이름 분기가
// 응답에 남기는 신호가 동일 — member_id·avatar_url·type·runtime_type뿐). 이 헬퍼가 전제로
// 하는 "이름이 없다=이름 없는 구성원"이라는 단일 사실이 이 화면에선 두 사실(진짜 없음/
// orphan) 중 하나를 지어내는 셈이라 적용하면 다른 방식으로 거짓말이 된다 — BE가
// orphan에만 별도 신호(예: resolved:false)를 싣고 이 화면이 그 신호로 갈라 쓰는 처방은
// story #3758(9번째 항목)로 분리했다.

//
// 유나 디자인 게이트 적기만②(2026-09-09) — `??`는 null/undefined만 잡고 빈 문자열은
// 그대로 통과시킨다. BE가 ""를 name으로 준 적은 실측 0건이지만(전부 None 아니면 실
// 문자열), 방어적으로 빈 문자열도 같은 폴백으로 묶는다 — "" 도 "이름 없음"과 같은 사실
// (표시할 이름이 없다)이라 다른 취급을 둘 이유가 없다.
export function memberDisplayLabel(name: string | null | undefined, t: (key: string) => string): string {
  return name ? name : t('memberUnnamed');
}
