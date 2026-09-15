// story #3903 — 알림함 inbox.*·보드 board.* 잔존 해요체 + 어조 가드 SCOPED_NAMESPACES 2
// 네임스페이스 승격(inbox·board). 자기 파일로 분리한 이유(PO 지시, 2026-09-15) — 공유
// verify-scoped-i18n-honorific-tone.test.ts를 매 스토리 PR이 손편집하면 같은 날 병렬로
// 뜨는 다른 §⑤ 톤 전환 PR과 매번 append-conflict가 난다(#4209에서 확認된 클래스, story
// #3916이 honorific-scope/*.json 디렉터리 설계로 SCOPED_NAMESPACES 자체는 이미 해결했지만
// "그 네임스페이스의 양성대조 테스트"는 여전히 공유 파일에 인라인되고 있었다). 이 승격의
// 유일한 메커니즘은 honorific-scope/inbox.json·board.json 2개 파일 추가뿐 — 이 파일은 그
// 승격이 실제로 작동하는지 증명하는 자기완결 테스트다(공유 파일은 0건 편집).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SCOPED_KEYS,
  findHonorificToneInScopedKeys,
  resolveEffectiveScopedKeys,
} from './verify-scoped-i18n-honorific-tone';
import { assertOutOfScopeFixtureIgnoredByEffectiveKeys } from './honorific-tone-out-of-scope-fixture';

describe('실 ko.json — inbox·board 네임스페이스 전량(story #3903 AC1/AC2)', () => {
  const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
  const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;

  it('SCOPED_KEYS+전 네임스페이스 전량(effective)의 ko.json 값에 합니다체 0건(story #3903 AC1 inbox 88·board 186=274키 전량 이관 확認)', () => {
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    expect(effectiveKeys.length).toBeGreaterThan(SCOPED_KEYS.length);
    expect(findHonorificToneInScopedKeys(ko, effectiveKeys)).toEqual([]);
  });

  it('양성대조 — inbox.markAllReadFailed를 원래 합니다체로 되돌리면 RED가 된다(namespace 전량 승격 증명)', () => {
    expect(SCOPED_KEYS as readonly string[]).not.toContain('inbox.markAllReadFailed');
    const mutated = JSON.parse(JSON.stringify(ko)) as Record<string, unknown>;
    (mutated.inbox as Record<string, unknown>).markAllReadFailed = '전체 읽음 처리에 실패했습니다';
    const effectiveKeys = resolveEffectiveScopedKeys(mutated);
    const findings = findHonorificToneInScopedKeys(mutated, effectiveKeys);
    expect(findings).toContainEqual({ key: 'inbox.markAllReadFailed', matches: ['습니다'], value: '전체 읽음 처리에 실패했습니다' });
  });

  // board.invalidTransition — 실 develop HEAD 전환 前 값(git show 6c22bc4ac4)을 그대로 재현.
  it('양성대조 — board.invalidTransition(ㅂ니다 계열)을 원래 합니다체로 되돌리면 RED가 된다(namespace 전량 승격 증명)', () => {
    expect(SCOPED_KEYS as readonly string[]).not.toContain('board.invalidTransition');
    const mutated = JSON.parse(JSON.stringify(ko)) as Record<string, unknown>;
    (mutated.board as Record<string, unknown>).invalidTransition = '유효하지 않은 상태 전이입니다';
    const effectiveKeys = resolveEffectiveScopedKeys(mutated);
    const findings = findHonorificToneInScopedKeys(mutated, effectiveKeys);
    expect(findings).toContainEqual({ key: 'board.invalidTransition', matches: ['ㅂ니다'], value: '유효하지 않은 상태 전이입니다' });
  });

  // 무관 PR no-op — 실 ko.json 키에 의존하면(canvas.*·docs.*·retro.sessionNotFound·
  // board.epicSwimlaneLoadError(#3921·#3923가 재도입) 순으로 이미 4회 재발) 계속
  // 깨진다 — 공유 헬퍼(honorific-tone-out-of-scope-fixture.ts, PO 3차 처방
  // 2026-09-15)로 통일해 이 클래스를 구조적으로 종식.
  it('무관 PR no-op — inbox·board 밖·SCOPED_KEYS 밖의 실 합니다체 키는 namespace 전량 승격 뒤에도 안 본다', () => {
    assertOutOfScopeFixtureIgnoredByEffectiveKeys(ko);
  });

  it('실 ko.json의 inbox leaf 개수가 하한(70) 이상이다(실측 88, honorific-scope/inbox.json)', () => {
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    const inboxLeafCount = effectiveKeys.filter((k) => k.startsWith('inbox.')).length;
    expect(inboxLeafCount).toBeGreaterThanOrEqual(70);
  });

  it('실 ko.json의 board leaf 개수가 하한(150) 이상이다(실측 186, honorific-scope/board.json)', () => {
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    const boardLeafCount = effectiveKeys.filter((k) => k.startsWith('board.')).length;
    expect(boardLeafCount).toBeGreaterThanOrEqual(150);
  });
});
