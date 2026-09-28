// story #4028(E-UX-OVERHAUL·v3 셸) — v3 대화가 주소의 `?compose=`를 입력창에 미리
// 채울 때의 순수 판정. 상한(2000)은 4021 first-instruction-redirect.tsx의
// `MAX_COMPOSE_LENGTH`와 같은 값(레거시 미러) — 그쪽 리다이렉트가 이미 초과분을 URL에
// 안 싣지만(buildFirstInstructionTarget tooLong 분기), 손으로 만든 주소 등 그 경로를
// 안 거친 compose를 위해 읽는 쪽에서도 방어적으로 같은 상한을 다시 건다. 넘으면
// 잘라서 싣지 않고(부분 지시가 오히려 위험) 대화만 열어 둔 채 안내만 띄운다(AC3).
export const MAX_COMPOSE_LENGTH = 2000;

export interface ComposeSeed {
  /** 입력창에 미리 채울 값(없음·빈값·상한 초과면 ''). */
  draft: string;
  /** 상한을 넘어 미리 채우지 못했음(안내 표시 여부). */
  tooLong: boolean;
}

/**
 * 주소에서 읽은 compose 원문(디코드된 값)으로 초기 입력값을 정한다.
 * - 없음/빈 문자열 → 시드 0(안내 0).
 * - 상한 초과 → 시드 0 + 안내(자르지 않는다).
 * - 그 외 → 그대로 시드.
 */
export function seedFromCompose(raw: string | null | undefined): ComposeSeed {
  if (!raw) return { draft: '', tooLong: false };
  if (raw.length > MAX_COMPOSE_LENGTH) return { draft: '', tooLong: true };
  return { draft: raw, tooLong: false };
}
