/**
 * story #0d1c69f3(v2 4호, 아티팩트 eb51f59e) — 인박스 알림 탭의 「제네릭 반복 붕괴」(라이브
 * 실측: 동일 문안 알림 121건) 완화. 문안(title/body) 자체는 BE 생성 소스(정직 유의 ⓐ) —
 * 이 모듈은 그 원문을 지어내지 않고 byte-identical 대조로만 그룹을 판별한다.
 */

export interface GenericGroupable {
  id: string;
  type: string;
  title: string;
  body: string | null;
  is_read: boolean;
  created_at: string;
}

export interface GenericGroup<T> {
  key: string;
  notifications: T[];
}

/** 같은 type+title+body(byte-identical)가 2건 이상이면 그룹으로 묶는다. 1건뿐이면 노이즈가
 * 아니므로 그룹 대상이 아니다(단건은 개별 유지 — story AC3, 카드홍수 회귀 금지). */
export function groupByIdenticalContent<T extends GenericGroupable>(
  items: T[],
): { groups: GenericGroup<T>[]; ungrouped: T[] } {
  const buckets = new Map<string, T[]>();
  for (const n of items) {
    // 카디르 QA(#3450) 적출 — 예전엔 `${type}::${title}::${body}` 문자열 조인이었는데,
    // title/body는 자유텍스트(BE 생성)라 그 안에 "::"가 실제로 들어올 수 있다(예:
    // title='b::c'+body='d' 가 title='b'+body='c::d' 와 같은 조인 문자열이 돼 서로 다른
    // 알림이 한 그룹으로 오분류된다). JSON.stringify는 각 필드를 이스케이프해 실어서
    // 배열 경계가 절대 안 흔들린다.
    const key = JSON.stringify([n.type, n.title, n.body ?? '']);
    const arr = buckets.get(key) ?? [];
    arr.push(n);
    buckets.set(key, arr);
  }

  const groups: GenericGroup<T>[] = [];
  const ungrouped: T[] = [];
  for (const [key, arr] of buckets) {
    if (arr.length >= 2) groups.push({ key, notifications: arr });
    else ungrouped.push(...arr);
  }
  return { groups, ungrouped };
}

// reference_type → 표시 라벨. 미상 타입은 raw 값을 그대로 노출한다(지어낸 라벨 대신 정직한
// fallback — getEventTypeCopy의 "raw 노출 0" 규율과는 반대축: 저건 이벤트 문안, 이건 짧은
// 참조 타입 태그라 raw 노출이 오히려 정직하다).
const REFERENCE_TYPE_LABEL_KEYS: Record<string, string> = {
  gate: 'referenceTypeGate',
  story: 'referenceTypeStory',
  task: 'referenceTypeTask',
  doc: 'referenceTypeDoc',
  doc_comment: 'referenceTypeDocComment',
  sprint: 'referenceTypeSprint',
};

/** reference_type → 짧은 표시 라벨. i18n 키가 없는(미상) reference_type은 원문 그대로
 * 보여준다(지어내지 않음). */
export function referenceTypeLabel(t: (key: string) => string, referenceType: string | null): string | null {
  if (!referenceType) return null;
  const key = REFERENCE_TYPE_LABEL_KEYS[referenceType];
  return key ? t(key) : referenceType;
}
