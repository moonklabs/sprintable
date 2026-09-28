// story #4067(유나 design-QA, 2026-09-19) — recipe-detail-view.tsx가 역할 dot을
// ROLE_DOT_PALETTE=[bg-info,success,warning,muted-fg,primary,destructive]에 인덱스로
// 매핑해 Publisher=초록·Compute=앰버처럼 역할이 status(좋음/주의/kill) 색으로 오독됐다
// (cost_tier #4438/#4433이 닫은 "categorical≠status 토큰"과 동일 클래스) — 게다가
// Object.keys 순서 의존이라 recipe마다 색이 안정적이지도 않았다.
//
// ORDER는 실 seed(backend/alembic/versions/0381_preset_marketing_video_production_
// recipe.py::_STAGE_METADATA)의 role 값 그대로(Creator/Director/Compute/Publisher) —
// 지어낸 순서가 아니다. positional index를 role KEY 자체에 고정해 stage_metadata의
// 삽입 순서(recipe마다 다를 수 있다)와 독립적으로 만든다.
const ORDER = ['Creator', 'Director', 'Compute', 'Publisher'] as const;

const ACCENT_COUNT = 6;

/** role KEY → `var(--role-accent-N)`(N=1..6, globals.css CVD-safe categorical 팔레트).
 * ORDER에 있는 role은 그 자리로, 없는 role(향후 seed 확장·org 커스텀)은 문자 코드 합의
 * 나머지로 안정 폴백한다 — 둘 다 role KEY만으로 결정돼(positional 아님) 같은 role은
 * 항상 같은 accent를 받는다(recipe·렌더 순서와 무관). */
export function roleAccentVar(role: string): string {
  const orderedIndex = ORDER.indexOf(role as (typeof ORDER)[number]);
  const index = orderedIndex >= 0 ? orderedIndex : charCodeSum(role);
  return `var(--role-accent-${(index % ACCENT_COUNT) + 1})`;
}

function charCodeSum(role: string): number {
  let sum = 0;
  for (let i = 0; i < role.length; i += 1) sum += role.charCodeAt(i);
  return sum;
}
