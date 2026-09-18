// story #3755(BE·표시명·결함 클래스, 페드루 PO 決 2026-09-09) — BE resolver가 display_name
// 없는 휴먼 구성원을 이메일/id 문자열로 지어내는 대신 정직하게 name: null을 돌리도록 고친
// 뒤(member_resolver.py 5자리), FE 소비처가 그 null을 각자 다르게 다루던 것(같은 사실이
// 화면마다 다른 낱말로 뜨거나, 조용히 빈 칸으로 사라지던 것)을 한 헬퍼로 수렴한다.
// channel-label.ts의 (value, t) 시그니처와 동형 — 새 기전 발명 금지. 실 소비처(2026-09-09
// 기준): activity-log-view.tsx·dashboard-activity-timeline.tsx(활동 로그 actor) ·
// organization/events/page.tsx(이벤트 발행 이력 sender).
//
// 대화 참여자 화면(chats/[conversation_id]/page.tsx)은 이 헬퍼를 직접 못 쓴다 — 참여자
// payload가 「실존 구성원인데 display_name만 없음」과 「orphan(member/alias 자체가
// 없음)」 둘 다 name=None으로 채워서다(member_resolver.py orphan-fallback·실존-무이름
// 분기가 같은 신호를 남김). story #3758(9번째, PO 決 2026-09-09) — BE가 `ResolvedMember.
// resolved: bool` 비트를 신설해(orphan만 False) 참여자 payload에 그대로 흘려보내고,
// 아래 `participantDisplayLabel()`이 그 비트로 갈라 이 헬퍼를 우회 없이 쓴다.
//
// 유나 디자인 게이트 적기만②(2026-09-09) — `??`는 null/undefined만 잡고 빈 문자열은
// 그대로 통과시킨다. BE가 ""를 name으로 준 적은 실측 0건이지만(전부 None 아니면 실
// 문자열), 방어적으로 빈 문자열도 같은 폴백으로 묶는다 — "" 도 "이름 없음"과 같은 사실
// (표시할 이름이 없다)이라 다른 취급을 둘 이유가 없다.
export function memberDisplayLabel(name: string | null | undefined, t: (key: string) => string): string {
  return name ? name : t('memberUnnamed');
}

// story #3758(9번째, PO 決 2026-09-09) — 대화 참여자 전용. `resolved === false`(진짜
// orphan — member/alias 해소 자체가 실패)는 t('unknownMember')(「알 수 없는 구성원」,
// 낱말 정 적용 — chats.unknownMember 값 자체는 이 스토리가 갱신) · 그 외(실존 구성원,
// 표시명만 없을 수 있음)는 memberDisplayLabel로 「이름 없는 구성원」/실명. activity-log-view.tsx
// auditActorProps(actor_id 유무로 가름)·publishHistorySenderLabel(sender_id 유무)과 같은
// 모양 — 여기는 신호가 BE가 직접 실어 보내는 `resolved` 비트라는 점만 다르다.
export function participantDisplayLabel(
  p: { name: string | null; resolved?: boolean },
  t: (key: string) => string,
  tc: (key: string) => string,
): string {
  // BE ResolvedMember.resolved 기본값(True)과 짝 — 필드 자체가 없는 호출부(레거시 캐시·
  // 아직 안 지나간 필드)는 "모른다"가 아니라 "실존"으로 읽는다. orphan만 명시 false.
  if (p.resolved === false) return t('unknownMember');
  return memberDisplayLabel(p.name, tc);
}

// story #3755 CHANGES(카디르 QA 지적 2026-09-09) — organization/events/page.tsx의
// PublishHistorySection용이었으나, `page.tsx`는 Next App Router가 named export 필드를
// 화이트리스트로 검사하는 특수 모듈이라(metadata/generateMetadata/revalidate 등 정해진
// 것 외 named export가 있으면 "is not a valid Page export field"로 next build가 실패
// — tsc/vitest는 이 층을 안 잡는다, 3757 뒤 별건 가드 후보) 일반 헬퍼는 여기로.
//
// sender_id는 있는데 sender_name이 null(실존 발신자, display_name 미설정)인 경우와
// sender_id 자체가 null(발신자 정보 자체가 없음)인 경우가 예전엔 둘 다
// eventPublishHistoryUnknownSender("알 수 없음")로 뭉뚱그려졌다 — activity-log-view.tsx
// auditActorProps와 동형 처방(sender_id 유무로 갈라 전자는 memberUnnamed).
export function publishHistorySenderLabel(
  item: { sender_id: string | null; sender_name: string | null },
  t: (key: string) => string,
  tc: (key: string) => string,
): string {
  if (!item.sender_id) return t('eventPublishHistoryUnknownSender');
  return memberDisplayLabel(item.sender_name, tc);
}
