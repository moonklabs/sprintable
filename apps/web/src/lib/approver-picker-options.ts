// story #3040 v3(선생님 확定·PO 사실관계, 2026-08-25) — 오늘 아침 실사고의 최종 원인은
// "동명 표시이름 구별 불가"였다: PO 대행 계정(sellerking)과 선생님 실계정(iamyoonjae) 둘 다
// 표시이름이 "송윤재"라, 결재자 지정 픽커가 이름만 렌더해 PO가 대행 계정에 오지정했다(org_members
// 는 (org_id,user_id) 유니크라 "한 계정 두 행"은 구조적으로 불가능 — 별개 두 계정이 동명일 뿐).
// 이 헬퍼가 그 지정 표면 전체(doc-gate-section.tsx·approval-request-card.tsx 위임 픽커)의
// 단일 소스 — 이메일 병기(AC1)+동명 경고(AC2)를 한 곳에서 계산해 두 픽커가 갈라지지 않게 한다.

export interface ApproverPickerMember {
  id: string;
  user_id: string | null;
  name?: string | null;
  email?: string | null;
  role: 'owner' | 'admin' | 'member';
}

export interface ApproverPickerOption {
  value: string;
  label: string;
}

export interface ApproverPickerOptionsResult {
  options: ApproverPickerOption[];
  /** AC2 — 같은 org 후보군 안에 동명 표시이름이 2명 이상이면 true(픽커가 경고 배너를 켜는 신호). */
  hasDuplicateNames: boolean;
}

/**
 * org owner/admin 후보(호출부 규율 그대로 — 본인 제외는 excludeId로) → 픽커 옵션.
 * label은 항상 "이름 (이메일)" 병기(AC1) — 이름 없으면 이메일만, 이메일도 없으면(비정상 —
 * User.email은 NOT NULL이라 이 갈래는 방어적 fallback일 뿐) user_id/id 앞 8자로 후퇴한다
 * (지어내지 않는다 — 8자 hash는 최소한 "구별은 되는" 정직한 값).
 */
export function buildApproverPickerOptions(
  members: ApproverPickerMember[],
  excludeId?: string,
): ApproverPickerOptionsResult {
  const eligible = members.filter((m) => (m.role === 'owner' || m.role === 'admin') && m.id !== excludeId);

  const nameCounts = new Map<string, number>();
  for (const m of eligible) {
    const name = m.name?.trim();
    if (name) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }
  const hasDuplicateNames = [...nameCounts.values()].some((count) => count > 1);

  const options = eligible.map((m) => {
    const name = m.name?.trim() || null;
    const email = m.email?.trim() || null;
    const label = name && email
      ? `${name} (${email})`
      : name ?? email ?? m.user_id?.slice(0, 8) ?? m.id.slice(0, 8);
    return { value: m.id, label };
  });

  return { options, hasDuplicateNames };
}
