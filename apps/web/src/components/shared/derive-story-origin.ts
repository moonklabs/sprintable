import type { BacklinkItem } from './entity-backlinks-section';

// story #2267(C-9) AC4/AC7 — 「출처(창조 근원)」는 컨테이너(epic/sprint/meeting_id)와 다른
// 축이다. relation이라는 BE DB CHECK로 닫힌 2값 집합(app/models/reference.py RELATIONS)의
// 'created_from'만 출처다 — 'none'(본문 멘션)이나 빈 배열은 「출처 없음」의 증거가 아니다.
// ⛔relation의 값 집합은 BE의 DB CHECK가 SSOT다 — 값이 늘면(예: 제3의 관계) 여기 판정도
// 같이 봐야 한다(오늘 gate_type에서 겪은 「세 목록」 함정과 같은 클래스).
// AC7 계약 — 찾았는지 여부만 답한다. 「없다」와 「미수집」을 가르는 마커가 BE에 없으므로,
// 못 찾았을 때의 문구는 항상 하나(originNotCollected)로 통일한다 — 호출부는 분기하지 않는다.
export function deriveStoryOrigin(items: BacklinkItem[]): BacklinkItem | null {
  return items.find((item) => item.relation === 'created_from') ?? null;
}
