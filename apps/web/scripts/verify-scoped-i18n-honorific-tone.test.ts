import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  HONORIFIC_TONE_EXCEPTIONS,
  MIN_TOTAL_LEAF_COUNT,
  SCOPED_KEYS,
  checkStaleExceptions,
  checkTotalLeafFloor,
  countAllLeaves,
  findAgentEndingQuestionLeak,
  findHardcodedParticleAfterPlaceholder,
  findHonorificToneInScopedKeys,
  findPersonaAdnominalTerminal,
  findUnsupportedLeafTypes,
  flattenAllLeafKeys,
  resolveEffectiveScopedKeys,
} from './verify-scoped-i18n-honorific-tone';
// story #3903(PO 처방 2026-09-15, 3차 정정) — "무관 PR no-op" 표본이 실 키(cage→board→
// #3921/#3923 재발)로 반복 재발해, 합성 fixture 헬퍼를 별도 모듈로 빼 모든 per-story
// 전용 테스트 파일이 공유한다(honorific-tone-out-of-scope-fixture.ts 자체 문서 참고).
// story #3927(전역 스캔 승격) — assertOutOfScopeFixtureIgnoredByEffectiveKeys가
// assertOutOfScopeFixtureCaughtByGlobalScan으로 반전됐다(그 파일 헤더 참고).
import {
  assertOutOfScopeFixtureCaughtByGlobalScan,
  assertOutOfScopeFixtureIgnoredBySopedKeysAlone,
} from './honorific-tone-out-of-scope-fixture';

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

  it('전달된 키 목록에 없는 namespace/key는 값이 합니다체여도 절대 안 본다(호출부가 넘긴 범위만 본다 — 핵심 계약)', () => {
    const findings = findHonorificToneInScopedKeys(
      { cage: { gateDetailNotFound: '게이트를 찾을 수 없습니다.' } },
      ['board.noStories'], // cage.gateDetailNotFound는 전달된 목록에 없음
    );
    expect(findings).toEqual([]);
  });

  it('키가 ko.json에 없으면(리팩터 등) 조용히 skip한다(타입 에러 아님)', () => {
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

describe('HONORIFIC_TONE_EXCEPTIONS — story #3877/#3927 baseline 0건', () => {
  it('그랜드파더 없이 빈 배열로 시작한다(전역 스캔 승격 뒤에도 예외 후보 실측 0 — legal·githubLinks 등 직접 확認)', () => {
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

describe('SCOPED_KEYS — story #3877 AC1 표 count-lock(레거시, story #3927부터는 필터링에 안 쓰임)', () => {
  it('정확히 104개(AC1 표 94 + AC4 orgBriefing 9 + 캡처 中 발견 1 — docs.emptyDescription)', () => {
    expect(SCOPED_KEYS).toHaveLength(104);
  });

  it('중복 키가 없다', () => {
    expect(new Set(SCOPED_KEYS).size).toBe(SCOPED_KEYS.length);
  });
});

describe('실 ko.json — 스코프 키 count-lock(SCOPED_KEYS 기본 인자 경로, baseline 0)', () => {
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

  // SCOPED_KEYS는 story #3927부터 필터링에 안 쓰이지만(전역 스캔이 기본), 기본 인자
  // 경로(findHonorificToneInScopedKeys(ko), keys 생략)는 여전히 SCOPED_KEYS만 본다 — 그
  // 경로 자체가 "명시적으로 좁은 목록을 넘기면 정말 그 목록만 본다"는 계약을 지킨다는 증거.
  it('SCOPED_KEYS 밖의 실 합니다체 키는(같은 namespace 안이어도) 기본 인자 경로가 안 본다', () => {
    assertOutOfScopeFixtureIgnoredBySopedKeysAlone(ko);
  });
});

// ---------------------------------------------------------------------------
// story #3927 — 스코프 목록형(SCOPED_NAMESPACES·honorific-scope/*.json·
// checkScopedNamespaceMinimums·네임스페이스별 leaf 하한 30여 개)을 전량 폐기하고
// "기본=ko.json 전체 스캔, 예외만 명시 목록"으로 뒤집었다. #3916~#3926이 쌓아 온
// "실 ko.json — X 네임스페이스 전량(story #NNNN)" 3형 검증(0건·양성대조·무관 PR no-op)
// 블록들은 전부 "그 네임스페이스가 등록됐는가"를 증명하는 것이었는데, 이제 등록이라는
// 개념 자체가 없다(전부 항상 스코프 안) — 그 역사적 증거들을 낱낱이 보존하는 대신, 같은
// 계약을 전역 기준으로 다시 증명하는 이 블록 하나로 합친다. 각 스토리가 실제로 그
// 네임스페이스를 해요체로 이관했다는 사실 자체는 develop의 실 ko.json이 0건이라는 것으로
// 이미 실측되며, 그 증거는 아래 "전역 스캔" 테스트가 매번 확認한다(리터럴 스냅샷 없이).
// ---------------------------------------------------------------------------

describe('resolveEffectiveScopedKeys / flattenAllLeafKeys — 순수 함수(story #3927부터 항상 전체)', () => {
  it('⭐ko 객체의 모든 leaf key를 낸다(네임스페이스 필터·레지스트리 조회 없음)', () => {
    const ko = {
      board: { acSaveFailed: '무관' },
      chats: { a: { b: 'x' }, c: 'y' }, // 중첩도 펼쳐진다
    };
    const effective = resolveEffectiveScopedKeys(ko);
    expect(effective.sort()).toEqual(['board.acSaveFailed', 'chats.a.b', 'chats.c'].sort());
  });

  it('flattenAllLeafKeys와 resolveEffectiveScopedKeys는 같은 결과를 낸다(후자는 전자의 얇은 별칭)', () => {
    const ko = { a: { b: 'x', c: { d: 'y' } } };
    expect(resolveEffectiveScopedKeys(ko)).toEqual(flattenAllLeafKeys(ko));
  });

  it('빈 ko({})는 빈 배열', () => {
    expect(resolveEffectiveScopedKeys({})).toEqual([]);
  });

  it('문자열이 아닌 leaf(배열 등)는 건너뛴다(타입 에러 아님)', () => {
    const effective = resolveEffectiveScopedKeys({ chats: { arr: ['a', 'b'], str: 'x' } });
    expect(effective).toContain('chats.str');
    expect(effective).not.toContain('chats.arr');
  });

  it('SCOPED_KEYS 크기보다 항상 크거나 같다(실 ko.json은 SCOPED_KEYS 104개보다 leaf가 훨씬 많다)', () => {
    const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
    const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;
    expect(resolveEffectiveScopedKeys(ko).length).toBeGreaterThan(SCOPED_KEYS.length);
  });
});

describe('checkTotalLeafFloor — 순수 함수(네임스페이스별 leaf 하한 30여 개를 대체하는 단일 전역 하한)', () => {
  it('⭐하한 밑이면 위반 1건을 낸다', () => {
    const violations = checkTotalLeafFloor({ a: { b: 'x' } }); // leaf 1개
    expect(violations).toEqual([{ actualCount: 1, minExpected: MIN_TOTAL_LEAF_COUNT }]);
  });

  it('음성대조 — 실 ko.json은 하한을 넉넉히 넘어 위반 0건', () => {
    const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
    const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;
    expect(checkTotalLeafFloor(ko)).toEqual([]);
    expect(countAllLeaves(ko)).toBeGreaterThanOrEqual(MIN_TOTAL_LEAF_COUNT);
  });

  it('실 ko.json leaf 수가 하한의 넉넉한 여유(~80% 마진, story #3916 관례) 안에 있다(대량 삭제 감지력 확認용 참고치)', () => {
    const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
    const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;
    const actual = countAllLeaves(ko);
    expect(actual).toBeGreaterThanOrEqual(MIN_TOTAL_LEAF_COUNT);
    // 하한이 실측치의 80% 근방이라는 것 자체를 고정(자연 증감은 통과, 대량 삭제는 fail-loud
    // — 예를 들어 leaf가 반토막 나면 이 비율 자체가 깨져 이 테스트가 먼저 신호를 준다).
    expect(MIN_TOTAL_LEAF_COUNT / actual).toBeGreaterThan(0.7);
    expect(MIN_TOTAL_LEAF_COUNT / actual).toBeLessThan(0.85);
  });
});

// story #3927 CHANGES 2(PO 리뷰, 2026-09-15) — HONORIFIC_TONE_EXCEPTIONS 자체가
// fail-open(예외를 건 자리가 나중에 고쳐져도 그 예외 항목이 조용히 안 지워진 채 남는)일
// 수 있다는 지적 — checkStaleExceptions로 봉쇄.
describe('checkStaleExceptions — 순수 함수(예외 목록 자체의 fail-open 봉쇄)', () => {
  it('⭐등록된 예외가 지금 ko.json 어디에도 안 걸리면(고쳐졌거나 키가 사라졌으면) stale로 잡는다', () => {
    const ko = { board: { a: '이미 해요체예요' } }; // 습니다 없음 — 예외가 더 이상 필요 없음
    const exceptions = HONORIFIC_TONE_EXCEPTIONS as { key: string; match: string; reason: string; addedBy: string }[];
    const before = exceptions.length;
    exceptions.push({ key: 'board.a', match: '습니다', reason: 'test', addedBy: 'test' });
    try {
      expect(checkStaleExceptions(ko)).toEqual([{ key: 'board.a', match: '습니다' }]);
    } finally {
      exceptions.length = before;
    }
  });

  it('음성대조 — 등록된 예외가 지금도 실제로 그 자리에 걸리면 stale 아님', () => {
    const ko = { board: { a: '아직 완료되지 않았습니다' } };
    const exceptions = HONORIFIC_TONE_EXCEPTIONS as { key: string; match: string; reason: string; addedBy: string }[];
    const before = exceptions.length;
    exceptions.push({ key: 'board.a', match: '습니다', reason: 'test', addedBy: 'test' });
    try {
      expect(checkStaleExceptions(ko)).toEqual([]);
    } finally {
      exceptions.length = before;
    }
  });

  it('실 ko.json — HONORIFIC_TONE_EXCEPTIONS(현재 0건)에 stale 항목 0건', () => {
    const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
    const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;
    expect(checkStaleExceptions(ko)).toEqual([]);
  });
});

// story #3932 AC6(카디르 #4335 리뷰 발견, pre-existing) — flattenAllLeafKeys가 배열 값을
// Array.isArray로 걸러 재귀 walk도, string 분기도 안 타 통째로 조용히 스킵하던 자리.
// findUnsupportedLeafTypes가 같은 walk에서 그 자리를 위반으로 기록해 RED로 승격한다.
describe('findUnsupportedLeafTypes — 순수 함수(배열 등 문자열도 객체도 아닌 leaf를 fail-open 없이 잡는다)', () => {
  it('⭐합성 배열 leaf를 위반으로 잡는다(number·null도 같이 — 배열만 특례 취급하지 않는다는 증거)', () => {
    const synthetic = {
      fakeNs: {
        arrLeaf: ['a', 'b'],
        strLeaf: '정상 문자열 leaf',
        numLeaf: 42,
        nullLeaf: null,
        nested: { ok: '정상 중첩 leaf' },
      },
    };
    expect(findUnsupportedLeafTypes(synthetic as unknown as Record<string, unknown>)).toEqual([
      { key: 'fakeNs.arrLeaf', type: 'array' },
      { key: 'fakeNs.numLeaf', type: 'number' },
      { key: 'fakeNs.nullLeaf', type: 'null' },
    ]);
  });

  it('음성대조 — 문자열·중첩 객체 leaf만 있으면 위반 0건', () => {
    const synthetic = { fakeNs: { strLeaf: '정상', nested: { ok: '정상' } } };
    expect(findUnsupportedLeafTypes(synthetic)).toEqual([]);
  });

  it('실 ko.json — 배열/숫자/null 등 지원하지 않는 leaf 타입 0건(모든 leaf가 문자열)', () => {
    const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
    const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;
    expect(findUnsupportedLeafTypes(ko)).toEqual([]);
  });
});

describe('실 ko.json — 전역 스캔(story #3927, 모든 네임스페이스가 항상 스코프)', () => {
  const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
  const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;

  it('⭐유도형 등식 — 전역 스캔이 보는 네임스페이스 집합이 ko.json 최상위 키 집합과 정확히 같다', () => {
    // story #3927 설계상 이 둘은 "같은 ko 객체에서 유도"라 항상 같다 — 이 테스트의 진짜
    // 역할은 미래에 누군가 flattenAllLeafKeys에 필터링 로직을 다시 끼워 넣어 스코프를
    // 몰래 좁히는 회귀를 잡는 것이다(그냥 항상 통과하는 죽은 테스트가 아니다).
    const scannedNamespaces = new Set(resolveEffectiveScopedKeys(ko).map((k) => k.split('.')[0]));
    const realNamespaces = new Set(Object.keys(ko));
    expect(scannedNamespaces).toEqual(realNamespaces);
  });

  it('ko.json 전체(모든 네임스페이스·leaf)에 합니다체 0건', () => {
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    expect(effectiveKeys.length).toBeGreaterThanOrEqual(MIN_TOTAL_LEAF_COUNT);
    expect(findHonorificToneInScopedKeys(ko, effectiveKeys)).toEqual([]);
  });

  // 양성대조 — story #3919가 마지막으로 승격한 네임스페이스 중 하나(presence)의 실 키를
  // 원래 합니다체로 되돌려도, "등록"이라는 절차 없이 전역 스캔이 곧바로 잡는지 확認한다.
  it('양성대조 — presence.empty를 원래 합니다체로 되돌리면 RED가 된다(등록 절차 없이 전역 스캔이 바로 잡는다)', () => {
    expect(SCOPED_KEYS as readonly string[]).not.toContain('presence.empty');
    const mutated = JSON.parse(JSON.stringify(ko)) as Record<string, unknown>;
    (mutated.presence as Record<string, unknown>).empty = '표시할 팀원이 없습니다';
    const effectiveKeys = resolveEffectiveScopedKeys(mutated);
    const findings = findHonorificToneInScopedKeys(mutated, effectiveKeys);
    expect(findings).toContainEqual({ key: 'presence.empty', matches: ['습니다'], value: '표시할 팀원이 없습니다' });
  });

  // 양성대조 — 이 카드가 새로 만든 네임스페이스(합성)도 등록 없이 전역 스캔에 걸린다는
  // 것을 증명한다 — 이게 이 스토리의 핵심 결함(fail-open) 처방이 실제로 작동한다는 증거.
  it('양성대조 — 등록된 적 없는 합성 네임스페이스도 전역 스캔에 걸린다(story #3927 핵심 계약)', () => {
    assertOutOfScopeFixtureCaughtByGlobalScan(ko);
  });
});

// ---------------------------------------------------------------------------
// story #3889 CHANGES 1(PO PR 코멘트, 2026-09-14 19:19Z) — 플레이스홀더 «값» 바로 뒤에
// 계사(예요/이에요)를 붙이면 런타임 값의 받침 유무에 따라 절반은 문법이 어긋난다(「입니다」
// 는 받침 무관이라 문제가 없었지만, 해요체 전환의 「예요/이에요」는 앞 음절 받침으로
// 갈린다 — 정적으로 알 수 없는 런타임 숫자/문자열 뒤엔 아예 계사를 안 붙이는 형으로
// 재작성해야 한다). content.channelPostsImageTooLarge 등 4키를 이 형으로 고쳤다 — 이
// 가드가 재발을 막는다. story #3927부터는 ko.json 전체 leaf를 본다(예전엔 스캔 범위를
// 네임스페이스가 늘 때마다 손으로 나열해야 했다).
// ---------------------------------------------------------------------------

describe('story #3889 CHANGES 1 — 플레이스홀더 값 뒤 계사(예요/이에요) 0(story #3927부터 ko.json 전체)', () => {
  const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
  const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;

  const PLACEHOLDER_COPULA_RE = /\}(예요|이에요)/;

  it('ko.json 전체 leaf에 "}예요"·"}이에요"(placeholder 바로 뒤 계사) 0건', () => {
    const values = resolveEffectiveScopedKeys(ko).map((k) => {
      const parts = k.split('.');
      let cur: unknown = ko;
      for (const p of parts) cur = (cur as Record<string, unknown>)[p];
      return [k, cur as string] as [string, string];
    });
    const violations = values.filter(([, v]) => PLACEHOLDER_COPULA_RE.test(v));
    expect(violations).toEqual([]);
  });

  it('양성대조 — content.channelPostsImageTooLarge를 원래(계사 형)로 되돌리면 RED가 된다', () => {
    const mutated = JSON.parse(JSON.stringify(ko)) as Record<string, unknown>;
    (mutated.content as Record<string, unknown>).channelPostsImageTooLarge =
      '{maxBytes} 이하만 첨부할 수 있는데 {sizeBytes}예요';
    const values = resolveEffectiveScopedKeys(mutated).map((k) => {
      const parts = k.split('.');
      let cur: unknown = mutated;
      for (const p of parts) cur = (cur as Record<string, unknown>)[p];
      return [k, cur as string] as [string, string];
    });
    const violations = values.filter(([, v]) => PLACEHOLDER_COPULA_RE.test(v));
    expect(violations).toContainEqual([
      'content.channelPostsImageTooLarge',
      '{maxBytes} 이하만 첨부할 수 있는데 {sizeBytes}예요',
    ]);
  });
});

// ---------------------------------------------------------------------------
// story #3900 axis ① — 의문형 합니다체(습니까 / ㅂ니까). matchesFormalRegister를 확장해
// 서술형(습니다·십시오·ㅂ니다)뿐 아니라 의문형까지 잡는지 확認한다(선생님 경로 톤).
// ---------------------------------------------------------------------------
describe('story #3900 axis ① — 의문형 합니다체(습니까·ㅂ니까)', () => {
  it('습니까(자음어간 의문)를 잡는다', () => {
    const findings = findHonorificToneInScopedKeys(
      { s: { deleteConfirm: '정말 삭제하시겠습니까?' } },
      ['s.deleteConfirm'],
    );
    expect(findings).toEqual([
      { key: 's.deleteConfirm', matches: ['습니까'], value: '정말 삭제하시겠습니까?' },
    ]);
  });

  it('ㅂ니까(모음어간 의문·「입니까」류)를 NFD 정규화로 잡는다', () => {
    const findings = findHonorificToneInScopedKeys(
      { s: { relationQuestion: '어떤 관계입니까?' } },
      ['s.relationQuestion'],
    );
    expect(findings).toEqual([
      { key: 's.relationQuestion', matches: ['ㅂ니까'], value: '어떤 관계입니까?' },
    ]);
  });

  it('해요체 의문(삭제할까요?·관계예요?)은 통과한다(과잉살상 아님)', () => {
    const findings = findHonorificToneInScopedKeys(
      { s: { a: '정말 삭제할까요?', b: '어떤 관계예요?' } },
      ['s.a', 's.b'],
    );
    expect(findings).toEqual([]);
  });

  // 양성대조(실 데이터) — settings.deleteConfirmTitle은 이미 해요체(「계정을 삭제할까요?」)로
  // 이관됐다. 원래(develop) 합니다체 의문형으로 되돌린 deep-clone에서 실 effectiveKeys 경로가
  // 정확히 이 자리에서 RED가 되는지, 그리고 손대지 않은 실 ko.json은 0건인지 확認한다.
  const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
  const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;

  it('양성대조 — settings.deleteConfirmTitle을 원래 합니다체 의문형으로 되돌리면 RED가 된다', () => {
    const mutated = JSON.parse(JSON.stringify(ko)) as Record<string, unknown>;
    (mutated.settings as Record<string, unknown>).deleteConfirmTitle = '정말 계정을 삭제하시겠습니까?';
    const effectiveKeys = resolveEffectiveScopedKeys(mutated);
    const findings = findHonorificToneInScopedKeys(mutated, effectiveKeys);
    expect(findings).toContainEqual({
      key: 'settings.deleteConfirmTitle', matches: ['습니까'], value: '정말 계정을 삭제하시겠습니까?',
    });
  });

  it('실 ko.json(무손상)은 effectiveKeys에 의문형 합니다체 0건', () => {
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    const findings = findHonorificToneInScopedKeys(ko, effectiveKeys)
      .filter((f) => f.matches.some((m) => m === '습니까' || m === 'ㅂ니까'));
    expect(findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// story #3900 axis ② — findPersonaAdnominalTerminal(완결 어미 없는 관형형 '는'/'인'+마침표).
// ---------------------------------------------------------------------------
describe('findPersonaAdnominalTerminal — 순수 판정 함수(axis ②)', () => {
  it("'…되돌리는.'·'…엣지인.'(관형형+마침표 종결)를 잡는다", () => {
    const findings = findPersonaAdnominalTerminal(
      { p: { a: '연결을 되돌리는.', b: '이건 엣지인.' } },
      ['p.a', 'p.b'],
    );
    expect(findings).toEqual([
      { key: 'p.a', value: '연결을 되돌리는.' },
      { key: 'p.b', value: '이건 엣지인.' },
    ]);
  });

  it("'만드는 것을 확인해요.'(관형형+의존명사)는 안 잡는다(정당한 관형형)", () => {
    const findings = findPersonaAdnominalTerminal(
      { p: { c: '만드는 것을 확인해요.' } },
      ['p.c'],
    );
    expect(findings).toEqual([]);
  });

  it("정상 '…해요.' 완결 문장은 안 잡는다", () => {
    const findings = findPersonaAdnominalTerminal(
      { p: { d: '바로 저장했어요.' } },
      ['p.d'],
    );
    expect(findings).toEqual([]);
  });

  // 양성대조(실 데이터) — agents 네임스페이스는 완결 문장으로 이관됐다(잔존 0). effectiveKeys
  // 전량, 그리고 agents.* 하위 전량이 관형형 종결 0건인지 실 ko.json으로 확認한다.
  const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
  const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;

  it('실 ko.json — agents 키(effectiveKeys 스캔)에 관형형 종결 0건', () => {
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    const agentsKeys = effectiveKeys.filter((k) => k.startsWith('agents.'));
    expect(agentsKeys.length).toBeGreaterThan(0);
    expect(findPersonaAdnominalTerminal(ko, agentsKeys)).toEqual([]);
  });

  it('실 ko.json — effectiveKeys 전량에 관형형 종결 0건', () => {
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    expect(findPersonaAdnominalTerminal(ko, effectiveKeys)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// story #3900 axis ③ — findHardcodedParticleAfterPlaceholder(플레이스홀더 뒤 고정 조사·전역).
// ---------------------------------------------------------------------------
describe('findHardcodedParticleAfterPlaceholder — 순수 판정 함수(axis ③·전역)', () => {
  it('중첩 leaf의 「{name}이 …」(플레이스홀더 뒤 고정 조사)를 dotted 경로로 잡는다', () => {
    const findings = findHardcodedParticleAfterPlaceholder({ a: { b: '{name}이 왔어요' } });
    expect(findings).toEqual([{ key: 'a.b', value: '{name}이 왔어요' }]);
  });

  it('이중형 「{name}이(가) …」은 안 잡는다(조사 뒤가 「(」라 허용)', () => {
    const findings = findHardcodedParticleAfterPlaceholder({ a: { b: '{name}이(가) 왔어요' } });
    expect(findings).toEqual([]);
  });

  it('실 ko.json 전체 leaf에 플레이스홀더 뒤 고정 조사 0건(19+6키 이관·{josa} 배선 확認)', () => {
    const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
    const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;
    expect(findHardcodedParticleAfterPlaceholder(ko)).toEqual([]);
  });
});

// story #3914 axis ④ — findAgentEndingQuestionLeak(에이전트 어미 누출 '…지?'·스코프 값).
describe('findAgentEndingQuestionLeak — 순수 판정 함수(axis ④)', () => {
  it("스코프 값이 '…지?' 반말 물음이면 잡는다(진행할지?·되돌아갈지?·삭제할지?·하는지?)", () => {
    const ko = {
      retro: { a: '{stage} 단계로 진행할지?', b: '되돌아갈지? 데이터는 보존돼요.' },
      standup: { c: '이 피드백을 삭제할지?' },
      chats: { d: '지금 시작할지 여쭤보는지?' },
    };
    const keys = ['retro.a', 'retro.b', 'standup.c', 'chats.d'];
    expect(findAgentEndingQuestionLeak(ko, keys)).toEqual([
      { key: 'retro.a', value: '{stage} 단계로 진행할지?' },
      { key: 'retro.b', value: '되돌아갈지? 데이터는 보존돼요.' },
      { key: 'standup.c', value: '이 피드백을 삭제할지?' },
      { key: 'chats.d', value: '지금 시작할지 여쭤보는지?' },
    ]);
  });

  it("완결 해요체 의문형(~까요?/~나요?/~가요? = '요?')은 안 잡는다(허용)", () => {
    const ko = {
      retro: { a: '{stage} 단계로 진행할까요?', b: '되돌아갈까요? 데이터는 보존돼요.' },
      standup: { c: '이 피드백을 삭제할까요?' },
      x: { d: '맞나요?', e: '어디인가요?' },
    };
    const keys = ['retro.a', 'retro.b', 'standup.c', 'x.d', 'x.e'];
    expect(findAgentEndingQuestionLeak(ko, keys)).toEqual([]);
  });

  it('⭐양성대조 — 실 ko.json에서 standup.deleteFeedbackConfirm을 「삭제할지?」로 되돌리면 스코프 스캔이 RED(1건)', () => {
    const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
    const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;
    (ko.standup as Record<string, unknown>).deleteFeedbackConfirm = '이 피드백을 삭제할지?';
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    expect(findAgentEndingQuestionLeak(ko, effectiveKeys)).toEqual([
      { key: 'standup.deleteFeedbackConfirm', value: '이 피드백을 삭제할지?' },
    ]);
  });

  it('음성대조 — 실 ko.json의 확인 다이얼로그 3건이 「~까요?」로 이관돼 0건(retro.stageForwardConfirm·retro.stageBackConfirm·standup.deleteFeedbackConfirm)', () => {
    const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
    const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;
    const keys = ['retro.stageForwardConfirm', 'retro.stageBackConfirm', 'standup.deleteFeedbackConfirm'];
    expect(findAgentEndingQuestionLeak(ko, keys)).toEqual([]);
  });
});
