import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SCOPED_KEYS,
  findHonorificToneInScopedKeys,
  resolveEffectiveScopedKeys,
} from './verify-scoped-i18n-honorific-tone';
import { assertOutOfScopeFixtureCaughtByGlobalScan } from './honorific-tone-out-of-scope-fixture';

// story #3921 — verifyEmail·setPassword 네임스페이스 전량(SCOPED_NAMESPACES 승격) —
// 두 페이지가 next-intl 미배선이라는(오판) 전제로 하드코딩 한국어를 직접 써 오던 것을
// i18n 키로 전환. 다른 namespace 승격 스토리들과 정확히 같은 3형 검증
// (0건·양성대조·무관 PR no-op).
//
// 페드루 PO 2차 지시(2026-09-15) — 이 블록은 원래 verify-scoped-i18n-honorific-tone.test.ts
// 끝에 덧붙이는 형태였다. 그런데 그 자리에 동시에 append하는 PR이 여럿(§⑤ 낱말드리프트
// 축④·#3921·#3923 등) 열려 있으면 같은 줄 근방을 건드려 CONFLICTING이 반복된다(#3916/#3909가
// SCOPED_NAMESPACES 스냅샷에서 없애려던 바로 그 append-충돌 클래스가 describe-block
// 수준에서 재발). 파일을 스토리별로 나누면 구조적으로 diff가 0(공유 파일은 전혀 안
// 건드림) — 이 파일이 그 분리형이다.
describe('실 ko.json — verifyEmail·setPassword 네임스페이스 전량(story #3921 AC1/AC2)', () => {
  const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
  const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;

  it('SCOPED_KEYS+전 네임스페이스 전량(effective)의 ko.json 값에 합니다체 0건(story #3921 AC1 verifyEmail 9·setPassword 11=20키 전량 이관 확認)', () => {
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    expect(effectiveKeys.length).toBeGreaterThan(SCOPED_KEYS.length);
    expect(findHonorificToneInScopedKeys(ko, effectiveKeys)).toEqual([]);
  });

  it('양성대조 — verifyEmail.verifiedSuccess를 원래 합니다체로 되돌리면 RED가 된다(namespace 전량 승격 증명)', () => {
    expect(SCOPED_KEYS as readonly string[]).not.toContain('verifyEmail.verifiedSuccess');
    const mutated = JSON.parse(JSON.stringify(ko)) as Record<string, unknown>;
    (mutated.verifyEmail as Record<string, unknown>).verifiedSuccess = '이메일 인증이 완료되었습니다.';
    const effectiveKeys = resolveEffectiveScopedKeys(mutated);
    const findings = findHonorificToneInScopedKeys(mutated, effectiveKeys);
    expect(findings).toContainEqual({ key: 'verifyEmail.verifiedSuccess', matches: ['습니다'], value: '이메일 인증이 완료되었습니다.' });
  });

  it('양성대조 — setPassword.alreadySet을 원래 합니다체로 되돌리면 RED가 된다(namespace 전량 승격 증명)', () => {
    expect(SCOPED_KEYS as readonly string[]).not.toContain('setPassword.alreadySet');
    const mutated = JSON.parse(JSON.stringify(ko)) as Record<string, unknown>;
    (mutated.setPassword as Record<string, unknown>).alreadySet = '이미 비밀번호가 설정되어 있습니다.';
    const effectiveKeys = resolveEffectiveScopedKeys(mutated);
    const findings = findHonorificToneInScopedKeys(mutated, effectiveKeys);
    expect(findings).toContainEqual({ key: 'setPassword.alreadySet', matches: ['습니다'], value: '이미 비밀번호가 설정되어 있습니다.' });
  });

  // 양성대조(ㅂ니다 계열) — verifyEmail.invalidLink("...링크입니다")로 NFD 처방이 이
  // 두 네임스페이스 승격에서도 실제로 작동하는지 확認(습니다 리터럴이 아닌 자리 — "입니다"
  // 는 「습니다」 리터럴 정규식과 다른 글자라 NFD 분해 검출로만 잡힌다).
  it('양성대조 — verifyEmail.invalidLink(ㅂ니다 계열)를 원래 합니다체로 되돌리면 RED가 된다', () => {
    expect(SCOPED_KEYS as readonly string[]).not.toContain('verifyEmail.invalidLink');
    const mutated = JSON.parse(JSON.stringify(ko)) as Record<string, unknown>;
    (mutated.verifyEmail as Record<string, unknown>).invalidLink = '유효하지 않은 인증 링크입니다.';
    const effectiveKeys = resolveEffectiveScopedKeys(mutated);
    const findings = findHonorificToneInScopedKeys(mutated, effectiveKeys);
    expect(findings).toContainEqual({ key: 'verifyEmail.invalidLink', matches: ['ㅂ니다'], value: '유효하지 않은 인증 링크입니다.' });
  });

  // 무관 PR no-op — story #3903(PO 3차 처방, 2026-09-15)가 board.epicSwimlaneLoadError
  // 실 키 fixture(이 파일이 원래 쓰던 것)를 해요체 전환+board 승격으로 무효화한 것을
  // 계기로, 모든 per-story 파일이 공유 합성 fixture 헬퍼로 전환(재발 방지 — 실 키를
  // 쓰면 어떤 네임스페이스든 승격/정리될 때마다 다시 깨진다).
  // story #3927(전역 스캔 승격) — 이 자리의 의미가 반전됐다: "등재 밖은 안 본다"가 아니라
  // "새 네임스페이스도 빠짐없이 잡힌다"가 이제 이 가드의 핵심 계약이다.
  it('story #3927 반전 — 등재 여부와 무관하게 합성 네임스페이스도 전역 스캔에 잡힌다', () => {
    assertOutOfScopeFixtureCaughtByGlobalScan(ko);
  });
});
