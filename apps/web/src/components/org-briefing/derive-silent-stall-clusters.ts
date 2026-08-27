/**
 * story #93b076c8(2250) FE — 「침묵의 정체」구간 묶음. doc `silence-stall-display-spec-93b076c8`
 * (유나 홈, 페드루 GO 2026-08-27). BE(`/api/v2/glance/attention` kind="stalled")는 무변경 계약 —
 * 전량·무변화 내림차순 배열만 낸다. 이 파일이 그 배열을 4구간(exclusive)으로 그룹만 한다
 * (개수 자르기 없음 — top-N 기각, «자르면 또 침묵»).
 *
 * ⛔이 엔드포인트는 이미 `project_id` 쿼리파라미터로 스코프돼 응답 전체가 **한 프로젝트**
 * 소속이다 — org-briefing의 다른 클러스터(falsified/loop 등)와 달리 cross-project 표시가
 * 필요 없다(모든 항목이 뷰어의 활성 프로젝트 소속). href 조립은 `projectHref`(기존 재사용,
 * 새 규약 발명 0).
 */
import { projectHref, type ViewerContext } from './derive-attention-clusters';

export interface RawSilentStallItem {
  kind: string;
  story_id: string | null;
  title: string | null;
  entered_state_at: string | null;
  entered_state_at_precision: string | null;
  assignee_member_id: string | null;
}

export interface RawSilentStallResponse {
  items: RawSilentStallItem[];
  stalled_computed_at: string;
  stalled_population_count: number;
}

export interface SilentStallItem {
  id: string;
  title: string;
  enteredStateAt: string;
  ageHours: number;
  assigneeMemberId: string | null;
  href: string;
}

export type SilentStallBucketKey = '48h-1w' | '1w-2w' | '2w-1mo' | '1mo+';

// 4구간(exclusive) — 페드루 확定 48h 임계 위에, 유나 발주서(doc 67a20b3c)가 표시 계층으로
// 얹은 마디(48h+81/1주+73/2주+52/1개월+16 실측 — 17→8류 "클린 단층"이 없어 개수 대신 구간
// 그 자체를 가시화). 시간 단위=시간(정수 곱셈만, 부동소수 오차 없음).
const BUCKET_DEFS: { key: SilentStallBucketKey; minHours: number; maxHours: number | null }[] = [
  { key: '48h-1w', minHours: 48, maxHours: 24 * 7 },
  { key: '1w-2w', minHours: 24 * 7, maxHours: 24 * 14 },
  { key: '2w-1mo', minHours: 24 * 14, maxHours: 24 * 30 },
  { key: '1mo+', minHours: 24 * 30, maxHours: null },
];

export interface SilentStallBucket {
  key: SilentStallBucketKey;
  items: SilentStallItem[];
}

export interface SilentStallClusters {
  totalCount: number;
  populationCount: number;
  computedAt: string;
  buckets: SilentStallBucket[];
}

const EMPTY: SilentStallClusters = {
  totalCount: 0,
  populationCount: 0,
  computedAt: '',
  buckets: BUCKET_DEFS.map((b) => ({ key: b.key, items: [] })),
};

function bucketKeyFor(ageHours: number): SilentStallBucketKey | null {
  for (const b of BUCKET_DEFS) {
    if (ageHours >= b.minHours && (b.maxHours === null || ageHours < b.maxHours)) return b.key;
  }
  return null; // 48h 미만(BE가 이미 48h+만 내지만, 방어적으로 — 안 보이는 게 지어내는 것보다 안전).
}

/**
 * raw `/glance/attention` 응답 → 4구간 클러스터. `now`는 테스트 주입용(기본 `Date.now()`) —
 * 순수 함수 유지(파일 어디도 암묵적으로 시각을 캡처하지 않는다).
 */
export function deriveSilentStallClusters(
  raw: RawSilentStallResponse | null,
  viewer: ViewerContext | undefined,
  activeProjectSlug: string | null,
  now: number = Date.now(),
): SilentStallClusters {
  // derive-exception-signals.ts와 동형 shape-safety — 같은 프록시(apiSuccess 이중랩) 소스라
  // 형상 불일치(items 배열 아님 등, 예: 테스트 목범용 스텁)는 crash가 아니라 "미가용"으로 삼킨다.
  if (!raw || !Array.isArray(raw.items)) return EMPTY;
  const items = raw.items
    .filter((i) => i.kind === 'stalled' && i.story_id && i.entered_state_at)
    .map((i): SilentStallItem => {
      const enteredMs = Date.parse(i.entered_state_at as string);
      const ageHours = (now - enteredMs) / (1000 * 60 * 60);
      return {
        id: i.story_id as string,
        title: i.title ?? '',
        enteredStateAt: i.entered_state_at as string,
        ageHours,
        assigneeMemberId: i.assignee_member_id,
        href: projectHref(viewer, activeProjectSlug, `/board?story=${i.story_id}`),
      };
    });

  const buckets: SilentStallBucket[] = BUCKET_DEFS.map((b) => ({ key: b.key, items: [] }));
  for (const item of items) {
    const key = bucketKeyFor(item.ageHours);
    if (!key) continue; // 48h 미만은 BE 계약상 안 와야 정상 — 방어적 무시(지어내지 않음).
    buckets.find((b) => b.key === key)!.items.push(item);
  }
  // ⛔BE는 이미 무변화 내림차순(entered_state_at 오름차순)으로 정렬해 낸다 — 여기서 다시
  // 정렬하는 건 재구현이 아니라 "필터가 순서를 안 흐트러뜨렸다"는 방어적 확인 성격이지만,
  // filter()는 상대 순서를 보존하므로 굳이 재정렬하지 않는다(BE 계약 신뢰).

  return {
    totalCount: items.length,
    populationCount: raw.stalled_population_count,
    computedAt: raw.stalled_computed_at,
    buckets,
  };
}
