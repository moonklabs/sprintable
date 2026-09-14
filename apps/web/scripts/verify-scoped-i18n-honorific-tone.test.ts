import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  HONORIFIC_TONE_EXCEPTIONS,
  SCOPED_KEYS,
  SCOPED_NAMESPACES,
  findHonorificToneInScopedKeys,
  resolveEffectiveScopedKeys,
} from './verify-scoped-i18n-honorific-tone';

describe('findHonorificToneInScopedKeys — 순수 판정 함수', () => {
  it('습니다로 끝나는 스코프 키 값을 잡는다', () => {
    const findings = findHonorificToneInScopedKeys(
      { board: { noStories: '스토리가 없습니다' } },
      ['board.noStories'],
    );
    expect(findings).toEqual([{ key: 'board.noStories', matches: ['습니다'], value: '스토리가 없습니다' }]);
  });

  it('십시오도 잡는다', () => {
    const findings = findHonorificToneInScopedKeys({ c: { d: '눌러 주십시오' } }, ['c.d']);
    expect(findings).toEqual([{ key: 'c.d', matches: ['십시오'], value: '눌러 주십시오' }]);
  });

  // 「ㅂ니다」(모음어간+ㅂ니다, 「합니다」·「됩니다」류) 실측 함정 — 완성형(NFC) 한글에서는
  // 그 ㅂ이 앞 음절의 **받침**으로 합쳐진 한 글자(합/됩/갑)라 독립된 「ㅂ」 자모 문자가 원문에
  // 없다. 순수 리터럴 정규식(/ㅂ니다/)이면 「합니다」·「됩니다」를 못 잡는다(orgBriefing 9키
  // 그라운딩 중 실측 발견 — decideGateContext="승인이 필요합니다" 등 3키가 이 형태였다).
  // NFD(자모 분해) 정규화 후 받침ㅂ(U+11B8)+분해된「니다」를 찾는 방식으로 처방했다.
  it('완성형 「합니다」·「됩니다」(모음어간+ㅂ니다)도 NFD 정규화로 잡는다', () => {
    const findings = findHonorificToneInScopedKeys(
      { a: { b: '지금 처리합니다' }, c: { d: '곧 완료됩니다' } },
      ['a.b', 'c.d'],
    );
    expect(findings).toEqual([
      { key: 'a.b', matches: ['ㅂ니다'], value: '지금 처리합니다' },
      { key: 'c.d', matches: ['ㅂ니다'], value: '곧 완료됩니다' },
    ]);
  });

  it('해요체 값은 통과한다(과잉살상 아님)', () => {
    const findings = findHonorificToneInScopedKeys(
      { board: { noStories: '스토리가 없어요' } },
      ['board.noStories'],
    );
    expect(findings).toEqual([]);
  });

  it('스코프 키 목록에 없는 namespace/key는 값이 합니다체여도 절대 안 본다(스코프 밖 무관 — 핵심 계약)', () => {
    const findings = findHonorificToneInScopedKeys(
      { cage: { gateDetailNotFound: '게이트를 찾을 수 없습니다.' } },
      ['board.noStories'], // cage.gateDetailNotFound는 스코프 목록에 없음
    );
    expect(findings).toEqual([]);
  });

  it('스코프 키가 ko.json에 없으면(리팩터 등) 조용히 skip한다(타입 에러 아님)', () => {
    const findings = findHonorificToneInScopedKeys({}, ['board.noStories']);
    expect(findings).toEqual([]);
  });

  it('HONORIFIC_TONE_EXCEPTIONS에 등록된 key·match 조합은 건너뛴다', () => {
    const exceptions = HONORIFIC_TONE_EXCEPTIONS as { key: string; match: string; reason: string; addedBy: string }[];
    const before = exceptions.length;
    exceptions.push({ key: 'board.a', match: '습니다', reason: 'test', addedBy: 'test' });
    try {
      const findings = findHonorificToneInScopedKeys(
        { board: { a: '있습니다', b: '없습니다' } },
        ['board.a', 'board.b'],
      );
      // a는 예외 처리, b는 예외 등록 안 됐으니 여전히 잡혀야 한다
      expect(findings).toEqual([{ key: 'board.b', matches: ['습니다'], value: '없습니다' }]);
    } finally {
      exceptions.length = before;
    }
  });
});

describe('HONORIFIC_TONE_EXCEPTIONS — story #3877 baseline 0건', () => {
  it('그랜드파더 없이 빈 배열로 시작한다(이 스토리가 SCOPED_KEYS 전수를 해요체로 이관했으므로)', () => {
    expect(HONORIFIC_TONE_EXCEPTIONS).toEqual([]);
  });
});

// 이 가드가 «실패할 수 있음»을 코드로 고정한다(양성대조) — 잡지 못하는 가드는 「이상
// 없음」과 「검사가 안 돈다」를 구별해 주지 않는다.
describe('AC — 가드는 고의 합니다체 주입을 잡아낸다(양성대조, 합성)', () => {
  it('스코프 키에 고의로 합니다체를 넣으면 빨갛게(finding 1건 이상) 된다', () => {
    const findings = findHonorificToneInScopedKeys(
      { board: { noStories: '스토리가 없습니다' } },
      ['board.noStories'],
    );
    expect(findings.length).toBeGreaterThan(0);
  });
});

describe('SCOPED_KEYS — story #3877 AC1 표 count-lock', () => {
  it('정확히 104개(AC1 표 94 + AC4 orgBriefing 9 + 캡처 中 발견 1 — docs.emptyDescription)', () => {
    expect(SCOPED_KEYS).toHaveLength(104);
  });

  it('중복 키가 없다', () => {
    expect(new Set(SCOPED_KEYS).size).toBe(SCOPED_KEYS.length);
  });
});

describe('실 ko.json — 스코프 키 count-lock(baseline 0, 새 자리 0)', () => {
  const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
  const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;

  it('SCOPED_KEYS 104개 전부의 ko.json 값에 합니다체 0건(story #3877 AC2 전량 이관 확認)', () => {
    expect(findHonorificToneInScopedKeys(ko)).toEqual([]);
  });

  // 페드루 PO 지시(2026-09-14) — "양성대조=표의 키 1개 되돌림 → RED(실 사고 키)". 합성
  // 객체가 아니라 실제 AC1 표의 키(board.noStories) 값을 원래(develop HEAD 실측) 합니다체로
  // 되돌려 이 가드가 정확히 그 자리에서 RED가 되는지 확認한다 — 스캐너 로직 자체가 아니라
  // 실 데이터 경로가 정말로 이 가드를 통과하는지의 최종 증거.
  it('양성대조 — AC1 표의 실 키(board.noStories) 하나를 원래 합니다체로 되돌리면 RED가 된다', () => {
    const mutated = JSON.parse(JSON.stringify(ko)) as Record<string, unknown>;
    (mutated.board as Record<string, unknown>).noStories = '스토리가 없습니다';
    const findings = findHonorificToneInScopedKeys(mutated);
    expect(findings).toContainEqual({ key: 'board.noStories', matches: ['습니다'], value: '스토리가 없습니다' });
  });

  // 양성대조 ②(ㅂ니다 계열) — AC4 orgBriefing 9키 中 3키(decideGateContext 등)는 원래
  // 「필요합니다」(모음어간+ㅂ니다) 형태라 습니다/십시오 리터럴이 없다 — NFD 처방이 실제로
  // 이 자리에서 작동하는지 실 키로 확認(합성 아님).
  it('양성대조 — orgBriefing.decideGateContext(ㅂ니다 계열)를 원래 값으로 되돌려도 RED가 된다', () => {
    const mutated = JSON.parse(JSON.stringify(ko)) as Record<string, unknown>;
    (mutated.orgBriefing as Record<string, unknown>).decideGateContext = '승인이 필요합니다';
    const findings = findHonorificToneInScopedKeys(mutated);
    expect(findings).toContainEqual({
      key: 'orgBriefing.decideGateContext', matches: ['ㅂ니다'], value: '승인이 필요합니다',
    });
  });

  // 페드루 PO 지시 — "무관 PR no-op(exit 0) 표본 1". SCOPED_KEYS 밖의 실 키(cage 네임스페이스
  // 안에 있지만 스코프 목록엔 없는 cage.gateDetailNotFound)는 실제로 develop에 합니다체 값
  // ("게이트를 찾을 수 없습니다.")을 그대로 가진 채 남아 있다 — 이 가드가 그 값을 건드리지
  // 않는다는 것을 합성이 아니라 실 데이터로 고정한다(SCOPED_KEYS 밖 키만 건드리는 PR은 이
  // 가드에서 no-op이어야 한다 — 같은 namespace(cage) 안에서도 키 단위로만 판정하는 것이 이
  // 가드의 핵심 설계 계약이다).
  it('무관 PR no-op — SCOPED_KEYS 밖의 실 합니다체 키(같은 namespace 안이어도)는 이 가드가 안 본다', () => {
    const outOfScopeValue = (ko.cage as Record<string, unknown> | undefined)?.gateDetailNotFound;
    expect(typeof outOfScopeValue).toBe('string');
    expect(outOfScopeValue as string).toMatch(/습니다|ㅂ니다|십시오/);
    expect(SCOPED_KEYS as readonly string[]).not.toContain('cage.gateDetailNotFound');
    expect(findHonorificToneInScopedKeys(ko)).toEqual([]); // cage.gateDetailNotFound가 합니다체여도 여전히 0건
  });
});

// ---------------------------------------------------------------------------
// story #3885 AC2 — SCOPED_NAMESPACES(chats 전량 승격) + resolveEffectiveScopedKeys.
// ---------------------------------------------------------------------------

describe('SCOPED_NAMESPACES — story #3885 AC2', () => {
  it('chats 하나만 등재됐다(다른 네임스페이스는 아직 잔존 채무가 있어 승격 대상 아님)', () => {
    expect(SCOPED_NAMESPACES).toEqual(['chats']);
  });
});

describe('resolveEffectiveScopedKeys — 순수 함수', () => {
  it('⭐SCOPED_KEYS ∪ SCOPED_NAMESPACES leaf 키 합집합(중복 제거)을 낸다', () => {
    const ko = {
      board: { acSaveFailed: '무관' }, // SCOPED_KEYS의 실 키 하나
      chats: { a: { b: 'x' }, c: 'y' }, // chats 네임스페이스 — 중첩도 펼쳐진다
    };
    const effective = resolveEffectiveScopedKeys(ko);
    expect(effective).toContain('board.acSaveFailed');
    expect(effective).toContain('chats.a.b');
    expect(effective).toContain('chats.c');
  });

  it('chats가 ko에 없으면(합성 fixture 등) namespace 쪽은 빈 배열로 안전하게 무시된다', () => {
    const effective = resolveEffectiveScopedKeys({ board: { acSaveFailed: 'x' } });
    expect(effective).toEqual(SCOPED_KEYS as unknown as string[]);
  });

  it('chats 안 문자열이 아닌 leaf(배열 등)는 건너뛴다(타입 에러 아님)', () => {
    const effective = resolveEffectiveScopedKeys({ chats: { arr: ['a', 'b'], str: 'x' } });
    expect(effective).toContain('chats.str');
    expect(effective).not.toContain('chats.arr');
  });
});

describe('실 ko.json — chats 네임스페이스 전량(story #3885 AC2)', () => {
  const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
  const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;

  it('SCOPED_KEYS+chats 전량(effective)의 ko.json 값에 합니다체 0건(story #3885 AC1 66키 전량 이관 확認)', () => {
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    expect(effectiveKeys.length).toBeGreaterThan(SCOPED_KEYS.length); // chats leaf가 실제로 더해졌다
    expect(findHonorificToneInScopedKeys(ko, effectiveKeys)).toEqual([]);
  });

  // 페드루 PO 지시(2026-09-14 17:39Z) — "양성대조=chats.noConversations 되돌림 RED(실 키)".
  // chats.noConversations는 SCOPED_KEYS 정적 목록엔 없다(104개 밖) — 이 자리가 RED가
  // 된다는 것 자체가 SCOPED_NAMESPACES(namespace 전량 승격) 메커니즘이 실제로 작동한다는
  // 증거다(정적 키 목록이 잡는 게 아니다).
  it('양성대조 — chats.noConversations를 원래 합니다체로 되돌리면 RED가 된다(namespace 전량 승격 증명)', () => {
    expect(SCOPED_KEYS as readonly string[]).not.toContain('chats.noConversations');
    const mutated = JSON.parse(JSON.stringify(ko)) as Record<string, unknown>;
    (mutated.chats as Record<string, unknown>).noConversations = '대화가 없습니다';
    const effectiveKeys = resolveEffectiveScopedKeys(mutated);
    const findings = findHonorificToneInScopedKeys(mutated, effectiveKeys);
    expect(findings).toContainEqual({ key: 'chats.noConversations', matches: ['습니다'], value: '대화가 없습니다' });
  });

  // 무관 PR no-op — chats도 아니고 SCOPED_KEYS에도 없는 실 키(cage.gateDetailNotFound)는
  // namespace 전량 승격 뒤에도 여전히 안 잡힌다(승격은 chats 하나만이지 전체 카탈로그가
  // 아니다).
  it('무관 PR no-op — chats 밖·SCOPED_KEYS 밖의 실 합니다체 키는 namespace 전량 승격 뒤에도 안 본다', () => {
    const outOfScopeValue = (ko.cage as Record<string, unknown> | undefined)?.gateDetailNotFound;
    expect(typeof outOfScopeValue).toBe('string');
    expect(outOfScopeValue as string).toMatch(/습니다|ㅂ니다|십시오/);
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    expect(effectiveKeys).not.toContain('cage.gateDetailNotFound');
    expect(findHonorificToneInScopedKeys(ko, effectiveKeys)).toEqual([]);
  });
});
