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

// story #3923 — unsubscribe·authResetRequired·forgotPassword·nativeOauthReturn
// 네임스페이스 전량(SCOPED_NAMESPACES 승격) — 3921(verify-email·set-password)이 발견한
// "next-intl 미배선" 오판 클래스의 나머지 app/ 페이지 전수. 다른 namespace 승격
// 스토리들과 정확히 같은 3형 검증(0건·양성대조·무관 PR no-op).
//
// 페드루 PO 2차 지시(2026-09-15, #3921과 동형) — 이 블록은 원래
// verify-scoped-i18n-honorific-tone.test.ts 끝에 덧붙이는 형태였다. 그런데 그 자리에
// 동시에 append하는 PR이 여럿(§⑤ 낱말드리프트 축④·#3921·#3923 등) 열려 있으면 같은 줄
// 근방을 건드려 CONFLICTING이 반복된다 — 파일을 스토리별로 나누면 구조적으로 diff가
// 0(공유 파일은 전혀 안 건드림). 이 파일이 그 분리형이다.
describe('실 ko.json — unsubscribe·authResetRequired·forgotPassword·nativeOauthReturn 네임스페이스 전량(story #3923 AC1/AC2)', () => {
  const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
  const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;

  it('SCOPED_KEYS+전 네임스페이스 전량(effective)의 ko.json 값에 합니다체 0건(story #3923 AC1 4네임스페이스=19키 전량 이관 확認)', () => {
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    expect(effectiveKeys.length).toBeGreaterThan(SCOPED_KEYS.length);
    expect(findHonorificToneInScopedKeys(ko, effectiveKeys)).toEqual([]);
  });

  it('양성대조 — unsubscribe.unsubscribed를 원래 합니다체로 되돌리면 RED가 된다(namespace 전량 승격 증명)', () => {
    expect(SCOPED_KEYS as readonly string[]).not.toContain('unsubscribe.unsubscribed');
    const mutated = JSON.parse(JSON.stringify(ko)) as Record<string, unknown>;
    (mutated.unsubscribe as Record<string, unknown>).unsubscribed = '안내 메일 수신이 해제되었습니다.';
    const effectiveKeys = resolveEffectiveScopedKeys(mutated);
    const findings = findHonorificToneInScopedKeys(mutated, effectiveKeys);
    expect(findings).toContainEqual({ key: 'unsubscribe.unsubscribed', matches: ['습니다'], value: '안내 메일 수신이 해제되었습니다.' });
  });

  it('양성대조 — forgotPassword.sentMessage를 원래 합니다체로 되돌리면 RED가 된다(namespace 전량 승격 증명)', () => {
    expect(SCOPED_KEYS as readonly string[]).not.toContain('forgotPassword.sentMessage');
    const mutated = JSON.parse(JSON.stringify(ko)) as Record<string, unknown>;
    (mutated.forgotPassword as Record<string, unknown>).sentMessage = '입력하신 이메일로 재설정 링크를 발송했습니다. 메일함을 확인해 주세요.';
    const effectiveKeys = resolveEffectiveScopedKeys(mutated);
    const findings = findHonorificToneInScopedKeys(mutated, effectiveKeys);
    expect(findings).toContainEqual({ key: 'forgotPassword.sentMessage', matches: ['습니다'], value: '입력하신 이메일로 재설정 링크를 발송했습니다. 메일함을 확인해 주세요.' });
  });

  // 양성대조(ㅂ니다 계열) — authResetRequired.body("유지됩니다" = 유지+됩니다, NFD 분해라야
  // 잡히는 자리 — "습니다" 리터럴이 아니다)로 NFD 처방이 이 네 네임스페이스 승격에서도
  // 실제로 작동하는지 확認.
  it('양성대조 — authResetRequired.body(ㅂ니다 계열)를 원래 합니다체로 되돌리면 RED가 된다', () => {
    expect(SCOPED_KEYS as readonly string[]).not.toContain('authResetRequired.body');
    const mutated = JSON.parse(JSON.stringify(ko)) as Record<string, unknown>;
    (mutated.authResetRequired as Record<string, unknown>).body =
      '안전한 로그인을 위해 비밀번호를 한 번 재설정해 주세요. 계정과 데이터는 그대로 유지됩니다.';
    const effectiveKeys = resolveEffectiveScopedKeys(mutated);
    const findings = findHonorificToneInScopedKeys(mutated, effectiveKeys);
    expect(findings).toContainEqual({
      key: 'authResetRequired.body', matches: ['ㅂ니다'],
      value: '안전한 로그인을 위해 비밀번호를 한 번 재설정해 주세요. 계정과 데이터는 그대로 유지됩니다.',
    });
  });

  it('양성대조 — authResetRequired.heading을 원래 합니다체로 되돌리면 RED가 된다(namespace 전량 승격 증명)', () => {
    expect(SCOPED_KEYS as readonly string[]).not.toContain('authResetRequired.heading');
    const mutated = JSON.parse(JSON.stringify(ko)) as Record<string, unknown>;
    (mutated.authResetRequired as Record<string, unknown>).heading = '보안이 강화되었습니다';
    const effectiveKeys = resolveEffectiveScopedKeys(mutated);
    const findings = findHonorificToneInScopedKeys(mutated, effectiveKeys);
    expect(findings).toContainEqual({ key: 'authResetRequired.heading', matches: ['습니다'], value: '보안이 강화되었습니다' });
  });

  // 무관 PR no-op — story #3903(PO 3차 처방, 2026-09-15)가 board.epicSwimlaneLoadError
  // 실 키 fixture(이 파일이 원래 쓰던 것)를 해요체 전환+board 승격으로 무효화한 것을
  // 계기로, 모든 per-story 파일이 공유 합성 fixture 헬퍼로 전환(재발 방지).
  // story #3927(전역 스캔 승격) — 이 자리의 의미가 반전됐다: "등재 밖은 안 본다"가 아니라
  // "새 네임스페이스도 빠짐없이 잡힌다"가 이제 이 가드의 핵심 계약이다.
  it('story #3927 반전 — 등재 여부와 무관하게 합성 네임스페이스도 전역 스캔에 잡힌다', () => {
    assertOutOfScopeFixtureCaughtByGlobalScan(ko);
  });
});
