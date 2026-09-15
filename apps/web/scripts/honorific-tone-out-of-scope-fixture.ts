import { expect } from 'vitest';
import {
  SCOPED_KEYS,
  findHonorificToneInScopedKeys,
  resolveEffectiveScopedKeys,
} from './verify-scoped-i18n-honorific-tone';

// story #3903(PO 처방 2026-09-15, 3차 정정) — "무관 PR no-op" 표본을 실 ko.json 키(예:
// board.epicSwimlaneLoadError)에 의존시키면, 그 네임스페이스가 나중에 승격되거나(3903이
// board를 승격) 원본 문구가 정리될 때마다(story #3920, 유나 16ns 착지 뒤엔 "스코프 밖
// 합니다체 실 키" 자체가 ko.json에 0이 될 전망) 이 표본이 반복적으로 깨진다. 실사고 이력
// — #3899→cage.gateDetailNotFound(승격으로 무효)→#3903→board.epicSwimlaneLoadError(톤
// 전환+승격으로 재차 무효)→#3921·#3923(같은 board.epicSwimlaneLoadError를 독립적으로
// 재도입, "3형 검증" per-story 분리 패턴이 퍼지며 같은 클래스가 여러 파일에 병렬 재발).
// 근본 처방: 실 키 대신 깊은 복사한 ko에 합성 네임스페이스를 주입해 검증하고, 이 모듈을
// **모든** per-story 전용 테스트 파일(verify-scoped-i18n-honorific-tone.<story>.test.ts)
// 과 공유 verify-scoped-i18n-honorific-tone.test.ts가 공통으로 import한다 — "실 키를
// 스코프 밖 표본으로 쓰는 테스트 0"이 구조적으로 성립(더 이상 파일마다 재발명 불가).
//
// story #3927(민, 전역 가드 승격) 착지 뒤에는 이 헬퍼의 단언 방향이 뒤집힐 예정이다 —
// "예외 목록에 없는 네임스페이스는 전부 잡힌다"가 새 기본이 되면 합성 ns도 걸려야 맞는
// 쪽으로 바뀐다. 그때 이 모듈 하나만 갱신하면 모든 소비 파일에 전파된다(그게 이 분리의
// 또 다른 이유 — 예전엔 파일마다 따로 고쳐야 했다).
const OUT_OF_SCOPE_FIXTURE_NAMESPACE = '__outOfScopeFixture3903';
export const OUT_OF_SCOPE_FIXTURE_KEY = `${OUT_OF_SCOPE_FIXTURE_NAMESPACE}.sample`;
// "습니다"를 리터럴로 포함(NFC 그대로) — "입니다"류는 실 스캐너가 NFD 정규화 뒤에야
// ㅂ니다로 잡는데, 이 자기검증 assert는 순수 정규식이라 NFD를 안 거친다(직접 리터럴만).
export const OUT_OF_SCOPE_FIXTURE_VALUE = '이것은 스코프 밖 합성 문장이라고 알렸습니다.';

export function withOutOfScopeFixture(ko: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(JSON.parse(JSON.stringify(ko)) as Record<string, unknown>),
    [OUT_OF_SCOPE_FIXTURE_NAMESPACE]: { sample: OUT_OF_SCOPE_FIXTURE_VALUE },
  };
}

/** SCOPED_NAMESPACES 승격 뒤에도(resolveEffectiveScopedKeys 경유) 등재 밖 네임스페이스는
 * 여전히 무시됨을 합성 fixture로 증명한다 — 대부분의 "무관 PR no-op" 블록이 쓴다. */
export function assertOutOfScopeFixtureIgnoredByEffectiveKeys(ko: Record<string, unknown>): void {
  const mutated = withOutOfScopeFixture(ko);
  expect(OUT_OF_SCOPE_FIXTURE_VALUE).toMatch(/습니다|ㅂ니다|십시오/);
  const effectiveKeys = resolveEffectiveScopedKeys(mutated);
  expect(effectiveKeys).not.toContain(OUT_OF_SCOPE_FIXTURE_KEY);
  expect(findHonorificToneInScopedKeys(mutated, effectiveKeys)).toEqual([]);
}

/** SCOPED_KEYS(고정 리스트) 밖 키는 namespace 승격과 무관하게 애초에 안 본다는 것을
 * 증명한다 — story #3877 원 블록 전용(effectiveKeys를 안 쓰는 유일한 자리). */
export function assertOutOfScopeFixtureIgnoredBySopedKeysAlone(ko: Record<string, unknown>): void {
  const mutated = withOutOfScopeFixture(ko);
  expect(SCOPED_KEYS as readonly string[]).not.toContain(OUT_OF_SCOPE_FIXTURE_KEY);
  expect(findHonorificToneInScopedKeys(mutated)).toEqual([]);
}
