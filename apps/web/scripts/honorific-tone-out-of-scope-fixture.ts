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
// story #3927(민, 전역 가드 승격, 2026-09-15) 착지 — 헬퍼의 단언 방향이 실제로 뒤집혔다.
// "예외 목록(HONORIFIC_TONE_EXCEPTIONS)에 없는 네임스페이스는 전부 잡힌다"가 새 기본이라
// 합성 ns도 이제 걸려야 맞다 — `assertOutOfScopeFixtureIgnoredByEffectiveKeys`를
// `assertOutOfScopeFixtureCaughtByGlobalScan`으로 이름+본문 반전. 이 모듈 하나만
// 갱신하면 모든 소비 파일(공유 테스트+per-story 전용 테스트)에 전파된다(그게 애초에 이
// 분리를 한 이유 — 예전엔 파일마다 따로 고쳐야 했다).
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

/** story #3927 이후 — 전역 스캔(resolveEffectiveScopedKeys=flattenAllLeafKeys 경유)이라
 * 등재 여부와 무관하게 새 네임스페이스도 반드시 잡힌다는 것을 합성 fixture로 증명한다 —
 * "새 네임스페이스도 빠짐없이 걸린다"는 이 가드의 핵심 계약에 대한 양성대조(예전 "무관 PR
 * no-op" 블록 대부분이 이걸 썼다 — 그 자리들은 이제 정반대 의미의 양성대조로 재사용). */
export function assertOutOfScopeFixtureCaughtByGlobalScan(ko: Record<string, unknown>): void {
  const mutated = withOutOfScopeFixture(ko);
  expect(OUT_OF_SCOPE_FIXTURE_VALUE).toMatch(/습니다|ㅂ니다|십시오/);
  const effectiveKeys = resolveEffectiveScopedKeys(mutated);
  expect(effectiveKeys).toContain(OUT_OF_SCOPE_FIXTURE_KEY);
  expect(findHonorificToneInScopedKeys(mutated, effectiveKeys)).toContainEqual({
    key: OUT_OF_SCOPE_FIXTURE_KEY,
    matches: ['습니다'],
    value: OUT_OF_SCOPE_FIXTURE_VALUE,
  });
}

/** SCOPED_KEYS(고정 리스트) 밖 키는 namespace 승격과 무관하게 애초에 안 본다는 것을
 * 증명한다 — story #3877 원 블록 전용(effectiveKeys를 안 쓰는 유일한 자리). */
export function assertOutOfScopeFixtureIgnoredBySopedKeysAlone(ko: Record<string, unknown>): void {
  const mutated = withOutOfScopeFixture(ko);
  expect(SCOPED_KEYS as readonly string[]).not.toContain(OUT_OF_SCOPE_FIXTURE_KEY);
  expect(findHonorificToneInScopedKeys(mutated)).toEqual([]);
}
