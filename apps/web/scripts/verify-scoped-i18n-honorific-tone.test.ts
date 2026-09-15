import {
  copyFileSync as fsCopyFileSync,
  mkdtempSync as fsMkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir as osTmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  HONORIFIC_TONE_EXCEPTIONS,
  SCOPED_KEYS,
  SCOPED_NAMESPACES,
  checkScopedNamespaceMinimums,
  findAgentEndingQuestionLeak,
  findHardcodedParticleAfterPlaceholder,
  findHonorificToneInScopedKeys,
  findPersonaAdnominalTerminal,
  loadHonorificScopeDir,
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

  // 페드루 PO 지시 — "무관 PR no-op(exit 0) 표본 1". SCOPED_KEYS 밖의 실 키(board 네임스페이스
  // 안에 있지만 스코프 목록엔 없는 board.epicSwimlaneLoadError)는 실제로 develop에 합니다체 값
  // ("불러오지 못했습니다. 잠시 후 다시 시도해 주세요.")을 그대로 가진 채 남아 있다 — 이
  // 가드가 그 값을 건드리지 않는다는 것을 합성이 아니라 실 데이터로 고정한다(SCOPED_KEYS
  // 밖 키만 건드리는 PR은 이 가드에서 no-op이어야 한다 — 같은 namespace(board) 안에서도
  // 키 단위로만 판정하는 것이 이 가드의 핵심 설계 계약이다).
  // story #3899 — 이전엔 cage.gateDetailNotFound를 이 자리(고정 fixture)로 썼으나, 3899가
  // cage를 SCOPED_NAMESPACES로 승격하며 그 값도 해요체로 이관(잔존 0)돼 더 이상 "스코프
  // 밖" 표본이 못 된다 — board.epicSwimlaneLoadError(board는 SCOPED_KEYS에 여러 키가
  // 개별 등재돼 있지만 이 leaf는 그 목록 밖)로 교체, 같은 구조의 표본 유지.
  it('무관 PR no-op — SCOPED_KEYS 밖의 실 합니다체 키(같은 namespace 안이어도)는 이 가드가 안 본다', () => {
    const outOfScopeValue = (ko.board as Record<string, unknown> | undefined)?.epicSwimlaneLoadError;
    expect(typeof outOfScopeValue).toBe('string');
    expect(outOfScopeValue as string).toMatch(/습니다|ㅂ니다|십시오/);
    expect(SCOPED_KEYS as readonly string[]).not.toContain('board.epicSwimlaneLoadError');
    expect(findHonorificToneInScopedKeys(ko)).toEqual([]); // board.epicSwimlaneLoadError가 합니다체여도 여전히 0건
  });
});

// ---------------------------------------------------------------------------
// story #3885 AC2 — SCOPED_NAMESPACES(chats 전량 승격) + resolveEffectiveScopedKeys.
// ---------------------------------------------------------------------------

// 애초 이 자리는 착수 시점 23개를 «하드코딩 스냅샷»으로 고정했었다 — 그런데 그 스냅샷
// 자체가 병렬 PR마다 손대야 하는 자리라, #3916이 없애려던 바로 그 append-충돌 클래스를
// 이 테스트가 재도입하는 역설이 있었다(story #3909 rebase 中 발견·PO 확認, 2026-09-15 —
// #3913(4317)·#3919(4325)가 병렬로 열려 같은 자리를 리터럴로 반복 재도입해 매번
// CONFLICTING이 난 것이 그 증거). story #3909 — 그래서 이 블록을 «파일 수/내용에서
// 직접 유도한 값과 대조»하는 자기 검증으로 바꾼다(페드루 지시: "정합 스냅샷 테스트는
// 3916 방식(파일 수 유도)에 맞춤") — 이제 새 네임스페이스가 추가돼도(새
// honorific-scope/<ns>.json 파일 하나만) 이 테스트는 정말로 안 건드려도 된다(하드코딩된
// 목록이 없으므로).
describe('SCOPED_NAMESPACES — honorific-scope/ 디렉터리에서 유도(story #3916 AC1 + #3909 자기검증화)', () => {
  const REAL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'honorific-scope');

  it('SCOPED_NAMESPACES가 honorific-scope/*.json 파일명(확장자 제외, 알파벳순)과 개수·이름·순서까지 정확히 일치한다', () => {
    const filenamesSorted = readdirSync(REAL_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
      .sort();
    expect(SCOPED_NAMESPACES).toEqual(filenamesSorted);
  });

  // 페드루 PO 리뷰(2026-09-15) — 위 테스트는 "같은 디렉터리에서 유도한 값끼리" 대조라
  // 틀릴 수 없는 표본이다(디렉터리 전체가 비거나 loadHonorificScopeDir 자체가 고장나도
  // 양쪽이 똑같이 비어 통과한다). 하드코딩이 아닌 하한 리터럴 하나로 그 사각을 막는다 —
  // 대량 삭제·로더 고장은 이 줄이 잡고, PR마다 이 줄을 고칠 필요는 없다(하한만 넘으면
  // 통과). story #3920(ko.json 최상위 네임스페이스 집합과의 «등식» 승격, 진행 中) 착지
  // 뒤 이 하한을 그 등식으로 교체한다.
  it('SCOPED_NAMESPACES가 최소 25개다(하한 리터럴 — 대량 삭제·로더 고장 감지, story #3920 전 임시)', () => {
    expect(SCOPED_NAMESPACES.length).toBeGreaterThanOrEqual(25);
  });

  it('loadHonorificScopeDir()의 각 minLeaf가 그 파일 자신의 원본 값과 정확히 일치한다(중간에 값이 새지 않음)', () => {
    const entries = loadHonorificScopeDir();
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      const raw = JSON.parse(readFileSync(path.join(REAL_DIR, `${e.namespace}.json`), 'utf8')) as { minLeaf: number };
      expect(e.minLeaf).toBe(raw.minLeaf);
    }
  });

  // 페드루 PO 리뷰(2026-09-15) — 위 테스트는 "같은 디렉터리에서 유도한 값끼리" 대조라
  // 틀릴 수 없는 표본이다(디렉터리 전체가 비거나 loadHonorificScopeDir 자체가 고장나도
  // 양쪽이 똑같이 비어 통과한다). 하드코딩이 아닌 하한 리터럴 하나로 그 사각을 막는다 —
  // 대량 삭제·로더 고장은 이 줄이 잡고, PR마다 이 줄을 고칠 필요는 없다(하한만 넘으면
  // 통과). story #3920(ko.json 최상위 네임스페이스 집합과의 «등식» 승격, 진행 中) 착지
  // 뒤 이 하한을 그 등식으로 교체한다.
  it('SCOPED_NAMESPACES가 최소 36개다(하한 리터럴 — 대량 삭제·로더 고장 감지, story #3920 전 임시)', () => {
    expect(SCOPED_NAMESPACES.length).toBeGreaterThanOrEqual(36);
  });
});

describe('loadHonorificScopeDir — 자기 테스트(story #3916 AC2, 병렬 무충돌 설계의 실 메커니즘 검증)', () => {
  const REAL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'honorific-scope');

  function copyDirToTemp(): string {
    const tmp = fsMkdtempSync(path.join(osTmpdir(), 'honorific-scope-test-'));
    for (const f of readdirSync(REAL_DIR)) {
      fsCopyFileSync(path.join(REAL_DIR, f), path.join(tmp, f));
    }
    return tmp;
  }

  it('파일 하나를 제거하면(임시 복사본) 유도 결과가 정확히 1건 줄어든다(count-lock 메커니즘 검증)', () => {
    const tmp = copyDirToTemp();
    try {
      const before = loadHonorificScopeDir(tmp);
      const removed = before[0]!.namespace;
      unlinkSync(path.join(tmp, `${removed}.json`));
      const after = loadHonorificScopeDir(tmp);
      expect(after.length).toBe(before.length - 1);
      expect(after.map((e) => e.namespace)).not.toContain(removed);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('minLeaf가 measuredLeaf보다 큰 파일이 있으면(임시 복사본, 데이터 입력 실수 시뮬레이션) throw한다', () => {
    const tmp = copyDirToTemp();
    try {
      const target = readdirSync(tmp)[0]!;
      const data = JSON.parse(readFileSync(path.join(tmp, target), 'utf8')) as { minLeaf: number; measuredLeaf: number };
      writeFileSync(path.join(tmp, target), JSON.stringify({ ...data, minLeaf: data.measuredLeaf + 1 }));
      expect(() => loadHonorificScopeDir(tmp)).toThrow(/minLeaf\(\d+\)가 measuredLeaf\(\d+\)보다 큽니다/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('음성대조 — 실 honorific-scope/ 디렉터리는 모든 파일이 minLeaf ≤ measuredLeaf라 throw 없이 로드된다', () => {
    expect(() => loadHonorificScopeDir()).not.toThrow();
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

  // 무관 PR no-op — chats도 아니고 SCOPED_KEYS에도 없는 실 키(board.epicSwimlaneLoadError,
  // story #3899 이후 cage 대신 쓰는 표본 — 위 SCOPED_KEYS describe 블록 참고)는 namespace
  // 전량 승격 뒤에도 여전히 안 잡힌다(승격은 chats 하나만이지 전체 카탈로그가 아니다).
  it('무관 PR no-op — chats 밖·SCOPED_KEYS 밖의 실 합니다체 키는 namespace 전량 승격 뒤에도 안 본다', () => {
    const outOfScopeValue = (ko.board as Record<string, unknown> | undefined)?.epicSwimlaneLoadError;
    expect(typeof outOfScopeValue).toBe('string');
    expect(outOfScopeValue as string).toMatch(/습니다|ㅂ니다|십시오/);
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    expect(effectiveKeys).not.toContain('board.epicSwimlaneLoadError');
    expect(findHonorificToneInScopedKeys(ko, effectiveKeys)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// story #3885 CHANGES①(PO PR 코멘트, 2026-09-14 18:02Z) — 네임스페이스 부재/개명
// fail-loud(flattenNamespaceLeafKeys가 []를 조용히 돌려줘 승격이 소리 없이 좁아지는
// 사각 봉쇄).
// ---------------------------------------------------------------------------

describe('checkScopedNamespaceMinimums — 순수 함수', () => {
  // story #3909 — 이 두 테스트도 예전엔 전 네임스페이스 목록을 손으로 나열해(23개) 새
  // 네임스페이스가 늘 때마다 편집이 필요했다(#3916이 없애려던 바로 그 패턴) — 실 등록
  // (loadHonorificScopeDir)에서 기대값을 유도해 파일 하나만 추가해도 이 테스트는 안
  // 건드리게 바꾼다.
  it('⭐등록된 모든 네임스페이스가 ko.json에 아예 없으면(개명·삭제 시뮬레이션) 등록 개수만큼 위반을 낸다', () => {
    const violations = checkScopedNamespaceMinimums({ board: { x: 'y' } }); // 등록된 네임스페이스 전부 없음
    const expected = loadHonorificScopeDir()
      .map((e) => ({ namespace: e.namespace, actualCount: 0, minExpected: e.minLeaf }))
      // 가드는 SCOPED_NAMESPACES(=loadHonorificScopeDir의 파일명 .sort(), 코드포인트) 순으로
      // 위반을 반환한다 — 기대값도 같은 코드포인트 순이어야 한다(localeCompare는 orgGatePolicy·
      // orgBriefing↔organization에서 .sort()와 갈려 story #3920 착수 시 이 테스트를 깨뜨렸다).
      .sort((a, b) => (a.namespace < b.namespace ? -1 : a.namespace > b.namespace ? 1 : 0));
    expect(violations).toEqual(expected);
  });

  it('⭐네임스페이스가 있지만 leaf가 하한 밑이면(부분 삭제·오염) 위반을 낸다', () => {
    const violations = checkScopedNamespaceMinimums({ chats: { a: 'x', b: 'y' } }); // 2개뿐, 나머지는 아예 없음
    const expected = loadHonorificScopeDir()
      .map((e) => ({ namespace: e.namespace, actualCount: e.namespace === 'chats' ? 2 : 0, minExpected: e.minLeaf }))
      // 가드는 SCOPED_NAMESPACES(=loadHonorificScopeDir의 파일명 .sort(), 코드포인트) 순으로
      // 위반을 반환한다 — 기대값도 같은 코드포인트 순이어야 한다(localeCompare는 orgGatePolicy·
      // orgBriefing↔organization에서 .sort()와 갈려 story #3920 착수 시 이 테스트를 깨뜨렸다).
      .sort((a, b) => (a.namespace < b.namespace ? -1 : a.namespace > b.namespace ? 1 : 0));
    expect(violations).toEqual(expected);
  });

  it('음성대조 — 실 ko.json은 하한을 넉넉히 넘어 위반 0건', () => {
    const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
    const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;
    expect(checkScopedNamespaceMinimums(ko)).toEqual([]);
  });
});

describe('SCOPED_NAMESPACE_MIN_LEAF_COUNT — 하한이 실측치보다 낮게 그라운딩됐다', () => {
  it('실 ko.json의 chats leaf 개수가 하한(200) 이상이다(실측 239)', () => {
    const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
    const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    const chatsLeafCount = effectiveKeys.filter((k) => k.startsWith('chats.')).length;
    expect(chatsLeafCount).toBeGreaterThanOrEqual(200);
  });

  it('실 ko.json의 content leaf 개수가 하한(500) 이상이다(실측 584)', () => {
    const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
    const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    const contentLeafCount = effectiveKeys.filter((k) => k.startsWith('content.')).length;
    expect(contentLeafCount).toBeGreaterThanOrEqual(500);
  });

  it('실 ko.json의 channelConnect leaf 개수가 하한(150) 이상이다(실측 174)', () => {
    const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
    const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    const channelConnectLeafCount = effectiveKeys.filter((k) => k.startsWith('channelConnect.')).length;
    expect(channelConnectLeafCount).toBeGreaterThanOrEqual(150);
  });

  it('실 ko.json의 settings leaf 개수가 하한(450) 이상이다(실측 538)', () => {
    const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
    const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    const settingsLeafCount = effectiveKeys.filter((k) => k.startsWith('settings.')).length;
    expect(settingsLeafCount).toBeGreaterThanOrEqual(450);
  });

  it('실 ko.json의 agents leaf 개수가 하한(150) 이상이다(실측 191, story #3895)', () => {
    const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
    const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    const agentsLeafCount = effectiveKeys.filter((k) => k.startsWith('agents.')).length;
    expect(agentsLeafCount).toBeGreaterThanOrEqual(150);
  });

  it('실 ko.json의 flow leaf 개수가 하한(160) 이상이다(실측 202, story #3895)', () => {
    const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
    const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    const flowLeafCount = effectiveKeys.filter((k) => k.startsWith('flow.')).length;
    expect(flowLeafCount).toBeGreaterThanOrEqual(160);
  });

  it('실 ko.json의 gateConfig leaf 개수가 하한(15) 이상이다(실측 20, story #3895)', () => {
    const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
    const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    const gateConfigLeafCount = effectiveKeys.filter((k) => k.startsWith('gateConfig.')).length;
    expect(gateConfigLeafCount).toBeGreaterThanOrEqual(15);
  });

  it('실 ko.json의 recruiter leaf 개수가 하한(100) 이상이다(실측 114)', () => {
    const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
    const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    const recruiterLeafCount = effectiveKeys.filter((k) => k.startsWith('recruiter.')).length;
    expect(recruiterLeafCount).toBeGreaterThanOrEqual(100);
  });

  it('실 ko.json의 loops leaf 개수가 하한(105) 이상이다(실측 119)', () => {
    const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
    const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    const loopsLeafCount = effectiveKeys.filter((k) => k.startsWith('loops.')).length;
    expect(loopsLeafCount).toBeGreaterThanOrEqual(105);
  });

  it('실 ko.json의 cage leaf 개수가 하한(230) 이상이다(실측 259)', () => {
    const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
    const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    const cageLeafCount = effectiveKeys.filter((k) => k.startsWith('cage.')).length;
    expect(cageLeafCount).toBeGreaterThanOrEqual(230);
  });

  it('실 ko.json의 onboarding leaf 개수가 하한(75) 이상이다(실측 88, story #3901)', () => {
    const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
    const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    const onboardingLeafCount = effectiveKeys.filter((k) => k.startsWith('onboarding.')).length;
    expect(onboardingLeafCount).toBeGreaterThanOrEqual(75);
  });

  it('실 ko.json의 login leaf 개수가 하한(30) 이상이다(실측 35, story #3901)', () => {
    const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
    const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    const loginLeafCount = effectiveKeys.filter((k) => k.startsWith('login.')).length;
    expect(loginLeafCount).toBeGreaterThanOrEqual(30);
  });

  it('실 ko.json의 storage leaf 개수가 하한(70) 이상이다(실측 82, story #3901)', () => {
    const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
    const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    const storageLeafCount = effectiveKeys.filter((k) => k.startsWith('storage.')).length;
    expect(storageLeafCount).toBeGreaterThanOrEqual(70);
  });

  it('실 ko.json의 insightsBoard leaf 개수가 하한(90) 이상이다(실측 103, story #3901)', () => {
    const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
    const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    const insightsBoardLeafCount = effectiveKeys.filter((k) => k.startsWith('insightsBoard.')).length;
    expect(insightsBoardLeafCount).toBeGreaterThanOrEqual(90);
  });

  it('실 ko.json의 standup leaf 개수가 하한(100) 이상이다(실측 118, story #3908)', () => {
    const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
    const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    const standupLeafCount = effectiveKeys.filter((k) => k.startsWith('standup.')).length;
    expect(standupLeafCount).toBeGreaterThanOrEqual(100);
  });

  it('실 ko.json의 goals leaf 개수가 하한(130) 이상이다(실측 148, story #3908)', () => {
    const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
    const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    const goalsLeafCount = effectiveKeys.filter((k) => k.startsWith('goals.')).length;
    expect(goalsLeafCount).toBeGreaterThanOrEqual(130);
  });

  it('실 ko.json의 usage leaf 개수가 하한(60) 이상이다(실측 67, story #3912)', () => {
    const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
    const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    const usageLeafCount = effectiveKeys.filter((k) => k.startsWith('usage.')).length;
    expect(usageLeafCount).toBeGreaterThanOrEqual(60);
  });

  it('실 ko.json의 invite leaf 개수가 하한(20) 이상이다(실측 26, story #3912)', () => {
    const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
    const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    const inviteLeafCount = effectiveKeys.filter((k) => k.startsWith('invite.')).length;
    expect(inviteLeafCount).toBeGreaterThanOrEqual(20);
  });

  it('실 ko.json의 meeting leaf 개수가 하한(50) 이상이다(실측 57, story #3912)', () => {
    const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
    const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    const meetingLeafCount = effectiveKeys.filter((k) => k.startsWith('meeting.')).length;
    expect(meetingLeafCount).toBeGreaterThanOrEqual(50);
  });

  it('실 ko.json의 supportWidget leaf 개수가 하한(20) 이상이다(실측 26, story #3912)', () => {
    const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
    const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    const supportWidgetLeafCount = effectiveKeys.filter((k) => k.startsWith('supportWidget.')).length;
    expect(supportWidgetLeafCount).toBeGreaterThanOrEqual(20);
  });

  it('실 ko.json의 agentRuns leaf 개수가 하한(55) 이상이다(실측 62, story #3913)', () => {
    const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
    const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    const agentRunsLeafCount = effectiveKeys.filter((k) => k.startsWith('agentRuns.')).length;
    expect(agentRunsLeafCount).toBeGreaterThanOrEqual(55);
  });

  it('실 ko.json의 nav leaf 개수가 하한(100) 이상이다(실측 115, story #3913)', () => {
    const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
    const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    const navLeafCount = effectiveKeys.filter((k) => k.startsWith('nav.')).length;
    expect(navLeafCount).toBeGreaterThanOrEqual(100);
  });

  // story #3918 — ActionZone(command-center) 은퇴로 dashboard.* leaf가 50→25(죽은
  // 25키 삭제, honorific-scope/dashboard.json도 재기준선 45→20) — 하한 값만 갱신.
  it('실 ko.json의 dashboard leaf 개수가 하한(20) 이상이다(실측 25, story #3913·재기준선 #3918)', () => {
    const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
    const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    const dashboardLeafCount = effectiveKeys.filter((k) => k.startsWith('dashboard.')).length;
    expect(dashboardLeafCount).toBeGreaterThanOrEqual(20);
  });

  it('실 ko.json의 presence leaf 개수가 하한(10) 이상이다(실측 12, story #3919)', () => {
    const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
    const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    const presenceLeafCount = effectiveKeys.filter((k) => k.startsWith('presence.')).length;
    expect(presenceLeafCount).toBeGreaterThanOrEqual(10);
  });

  it('실 ko.json의 commandPalette leaf 개수가 하한(17) 이상이다(실측 21, story #3919)', () => {
    const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
    const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    const commandPaletteLeafCount = effectiveKeys.filter((k) => k.startsWith('commandPalette.')).length;
    expect(commandPaletteLeafCount).toBeGreaterThanOrEqual(17);
  });

  it('실 ko.json의 accountSwitcher leaf 개수가 하한(7) 이상이다(실측 9, story #3919)', () => {
    const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
    const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    const accountSwitcherLeafCount = effectiveKeys.filter((k) => k.startsWith('accountSwitcher.')).length;
    expect(accountSwitcherLeafCount).toBeGreaterThanOrEqual(7);
  });

  it('실 ko.json의 common leaf 개수가 하한(25) 이상이다(실측 30, story #3919)', () => {
    const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
    const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    const commonLeafCount = effectiveKeys.filter((k) => k.startsWith('common.')).length;
    expect(commonLeafCount).toBeGreaterThanOrEqual(25);
  });

  it('실 ko.json의 activityLog leaf 개수가 하한(10) 이상이다(실측 13, story #3919)', () => {
    const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
    const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    const activityLogLeafCount = effectiveKeys.filter((k) => k.startsWith('activityLog.')).length;
    expect(activityLogLeafCount).toBeGreaterThanOrEqual(10);
  });

  it('실 ko.json의 teamActivity leaf 개수가 하한(16) 이상이다(실측 20, story #3919)', () => {
    const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
    const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    const teamActivityLeafCount = effectiveKeys.filter((k) => k.startsWith('teamActivity.')).length;
    expect(teamActivityLeafCount).toBeGreaterThanOrEqual(16);
  });

  it('실 ko.json의 agentPerformance leaf 개수가 하한(9) 이상이다(실측 11, story #3919)', () => {
    const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
    const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    const agentPerformanceLeafCount = effectiveKeys.filter((k) => k.startsWith('agentPerformance.')).length;
    expect(agentPerformanceLeafCount).toBeGreaterThanOrEqual(9);
  });

  it('실 ko.json의 sprints leaf 개수가 하한(70) 이상이다(실측 86, story #3919)', () => {
    const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
    const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    const sprintsLeafCount = effectiveKeys.filter((k) => k.startsWith('sprints.')).length;
    expect(sprintsLeafCount).toBeGreaterThanOrEqual(70);
  });

  it('실 ko.json의 canvas leaf 개수가 하한(100) 이상이다(실측 114, story #3909)', () => {
    const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
    const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    const canvasLeafCount = effectiveKeys.filter((k) => k.startsWith('canvas.')).length;
    expect(canvasLeafCount).toBeGreaterThanOrEqual(100);
  });

  it('실 ko.json의 docs leaf 개수가 하한(220) 이상이다(실측 245, story #3909)', () => {
    const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
    const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    const docsLeafCount = effectiveKeys.filter((k) => k.startsWith('docs.')).length;
    expect(docsLeafCount).toBeGreaterThanOrEqual(220);
  });
});

// ---------------------------------------------------------------------------
// story #3919 — presence·commandPalette·accountSwitcher·common·activityLog·teamActivity·
// agentPerformance·sprints 네임스페이스 전량(SCOPED_NAMESPACES 승격). onboarding/login/
// storage/insightsBoard(#3901)와 정확히 같은 3형 검증(0건·양성대조·무관 PR no-op).
// ---------------------------------------------------------------------------

describe('실 ko.json — presence·commandPalette·accountSwitcher·common·activityLog·teamActivity·agentPerformance·sprints 네임스페이스 전량(story #3919 AC1/AC3)', () => {
  const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
  const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;

  it('SCOPED_KEYS+전 네임스페이스 전량(effective)의 ko.json 값에 합니다체 0건(story #3919 AC1 8네임스페이스=22키 전량 이관 확認)', () => {
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    expect(effectiveKeys.length).toBeGreaterThan(SCOPED_KEYS.length);
    expect(findHonorificToneInScopedKeys(ko, effectiveKeys)).toEqual([]);
  });

  it('양성대조 — presence.empty를 원래 합니다체로 되돌리면 RED가 된다(namespace 전량 승격 증명)', () => {
    expect(SCOPED_KEYS as readonly string[]).not.toContain('presence.empty');
    const mutated = JSON.parse(JSON.stringify(ko)) as Record<string, unknown>;
    (mutated.presence as Record<string, unknown>).empty = '표시할 에이전트가 없습니다';
    const effectiveKeys = resolveEffectiveScopedKeys(mutated);
    const findings = findHonorificToneInScopedKeys(mutated, effectiveKeys);
    expect(findings).toContainEqual({ key: 'presence.empty', matches: ['습니다'], value: '표시할 에이전트가 없습니다' });
  });

  it('양성대조 — accountSwitcher.switchFailed를 원래 합니다체로 되돌리면 RED가 된다(namespace 전량 승격 증명)', () => {
    expect(SCOPED_KEYS as readonly string[]).not.toContain('accountSwitcher.switchFailed');
    const mutated = JSON.parse(JSON.stringify(ko)) as Record<string, unknown>;
    (mutated.accountSwitcher as Record<string, unknown>).switchFailed = '계정 전환에 실패했습니다. 다시 시도해 주세요.';
    const effectiveKeys = resolveEffectiveScopedKeys(mutated);
    const findings = findHonorificToneInScopedKeys(mutated, effectiveKeys);
    expect(findings).toContainEqual({ key: 'accountSwitcher.switchFailed', matches: ['습니다'], value: '계정 전환에 실패했습니다. 다시 시도해 주세요.' });
  });

  it('양성대조 — teamActivity.emptyTitle을 원래 합니다체로 되돌리면 RED가 된다(namespace 전량 승격 증명)', () => {
    expect(SCOPED_KEYS as readonly string[]).not.toContain('teamActivity.emptyTitle');
    const mutated = JSON.parse(JSON.stringify(ko)) as Record<string, unknown>;
    (mutated.teamActivity as Record<string, unknown>).emptyTitle = '아직 활동이 없습니다';
    const effectiveKeys = resolveEffectiveScopedKeys(mutated);
    const findings = findHonorificToneInScopedKeys(mutated, effectiveKeys);
    expect(findings).toContainEqual({ key: 'teamActivity.emptyTitle', matches: ['습니다'], value: '아직 활동이 없습니다' });
  });

  // 양성대조(ㅂ니다 계열) — common.upgradeRequired("필요합니다")로 NFD 처방이 이 여덟
  // 네임스페이스 승격에서도 실제로 작동하는지 확認(습니다 리터럴이 아닌 자리).
  it('양성대조 — common.upgradeRequired(ㅂ니다 계열)를 원래 합니다체로 되돌리면 RED가 된다', () => {
    expect(SCOPED_KEYS as readonly string[]).not.toContain('common.upgradeRequired');
    const mutated = JSON.parse(JSON.stringify(ko)) as Record<string, unknown>;
    (mutated.common as Record<string, unknown>).upgradeRequired = '업그레이드가 필요합니다';
    const effectiveKeys = resolveEffectiveScopedKeys(mutated);
    const findings = findHonorificToneInScopedKeys(mutated, effectiveKeys);
    expect(findings).toContainEqual({ key: 'common.upgradeRequired', matches: ['ㅂ니다'], value: '업그레이드가 필요합니다' });
  });

  it('무관 PR no-op — 8 네임스페이스 밖·SCOPED_KEYS 밖의 실 합니다체 키는 namespace 전량 승격 뒤에도 안 본다', () => {
    const outOfScopeValue = (ko.board as Record<string, unknown> | undefined)?.epicSwimlaneLoadError;
    expect(typeof outOfScopeValue).toBe('string');
    expect(outOfScopeValue as string).toMatch(/습니다|ㅂ니다|십시오/);
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    expect(effectiveKeys).not.toContain('board.epicSwimlaneLoadError');
    expect(findHonorificToneInScopedKeys(ko, effectiveKeys)).toEqual([]);
  });

  // story #3919 — presence.panelTitle·fabLabelWorking의 영문 「presence」 낱말 제거 확認
  // (§⑤: ko 화면에 코드/영문 낱말 0). 「팀 현황」으로 통일.
  it('presence.panelTitle·fabLabelWorking에 더는 영문 「presence」가 없다(§⑤ 낱말 축)', () => {
    expect(ko.presence).toBeDefined();
    const p = ko.presence as Record<string, unknown>;
    expect(p.panelTitle).not.toMatch(/presence/i);
    expect(p.fabLabelWorking).not.toMatch(/presence/i);
    expect(p.panelTitle).toBe('팀 현황');
    expect(p.fabLabelWorking).toBe('팀 현황 · {count}명 작업 중');
  });
});

// story #3923 — unsubscribe·authResetRequired·forgotPassword·nativeOauthReturn 네임스페이스
// 전량 검증은 별도 파일 verify-scoped-i18n-honorific-tone.3923.test.ts로 분리(페드루 PO
// 2차 지시, 2026-09-15 — 병렬 append PR 다수라 이 공유 파일에 블록을 덧붙이면 구조적으로
// 충돌 재발).

// ---------------------------------------------------------------------------
// story #3909 — canvas·docs 네임스페이스 전량(SCOPED_NAMESPACES 승격, honorific-scope/
// canvas.json·docs.json). 다른 namespace 승격 스토리들과 정확히 같은 3형 검증
// (0건·양성대조·무관 PR no-op).
// ---------------------------------------------------------------------------

describe('실 ko.json — canvas·docs 네임스페이스 전량(story #3909 AC1/AC2)', () => {
  const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
  const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;

  it('SCOPED_KEYS+전 네임스페이스 전량(effective)의 ko.json 값에 합니다체 0건(story #3909 AC1 canvas 20·docs 21=41키 전량 이관 확認)', () => {
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    expect(effectiveKeys.length).toBeGreaterThan(SCOPED_KEYS.length);
    expect(findHonorificToneInScopedKeys(ko, effectiveKeys)).toEqual([]);
  });

  it('양성대조 — canvas.canvasEmptyContent를 원래 합니다체로 되돌리면 RED가 된다(namespace 전량 승격 증명)', () => {
    expect(SCOPED_KEYS as readonly string[]).not.toContain('canvas.canvasEmptyContent');
    const mutated = JSON.parse(JSON.stringify(ko)) as Record<string, unknown>;
    (mutated.canvas as Record<string, unknown>).canvasEmptyContent = '이 산출물에는 아직 콘텐츠가 없습니다';
    const effectiveKeys = resolveEffectiveScopedKeys(mutated);
    const findings = findHonorificToneInScopedKeys(mutated, effectiveKeys);
    expect(findings).toContainEqual({
      key: 'canvas.canvasEmptyContent', matches: ['습니다'], value: '이 산출물에는 아직 콘텐츠가 없습니다',
    });
  });

  it('양성대조 — docs.noDocs를 원래 합니다체로 되돌리면 RED가 된다(namespace 전량 승격 증명)', () => {
    expect(SCOPED_KEYS as readonly string[]).not.toContain('docs.noDocs');
    const mutated = JSON.parse(JSON.stringify(ko)) as Record<string, unknown>;
    (mutated.docs as Record<string, unknown>).noDocs = '문서가 없습니다';
    const effectiveKeys = resolveEffectiveScopedKeys(mutated);
    const findings = findHonorificToneInScopedKeys(mutated, effectiveKeys);
    expect(findings).toContainEqual({
      key: 'docs.noDocs', matches: ['습니다'], value: '문서가 없습니다',
    });
  });

  it('무관 PR no-op — canvas·docs 밖·SCOPED_KEYS 밖의 실 합니다체 키는 namespace 전량 승격 뒤에도 안 본다', () => {
    const outOfScopeValue = (ko.board as Record<string, unknown> | undefined)?.epicSwimlaneLoadError;
    expect(typeof outOfScopeValue).toBe('string');
    expect(outOfScopeValue as string).toMatch(/습니다|ㅂ니다|십시오/);
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    expect(effectiveKeys).not.toContain('board.epicSwimlaneLoadError');
    expect(findHonorificToneInScopedKeys(ko, effectiveKeys)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// story #3913 — agentRuns·nav·dashboard 네임스페이스 전량(SCOPED_NAMESPACES 승격).
// onboarding/login/storage/insightsBoard(#3901)와 정확히 같은 3형 검증
// (0건·양성대조·무관 PR no-op).
// ---------------------------------------------------------------------------

describe('실 ko.json — agentRuns·nav·dashboard 네임스페이스 전량(story #3913 AC1/AC2)', () => {
  const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
  const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;

  it('SCOPED_KEYS+전 네임스페이스 전량(effective)의 ko.json 값에 합니다체 0건(story #3913 AC1 agentRuns 9·nav 8·dashboard 8=25키 전량 이관 확認)', () => {
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    expect(effectiveKeys.length).toBeGreaterThan(SCOPED_KEYS.length);
    expect(findHonorificToneInScopedKeys(ko, effectiveKeys)).toEqual([]);
  });

  it('양성대조 — agentRuns.emptyTitle을 원래 합니다체로 되돌리면 RED가 된다(namespace 전량 승격 증명)', () => {
    expect(SCOPED_KEYS as readonly string[]).not.toContain('agentRuns.emptyTitle');
    const mutated = JSON.parse(JSON.stringify(ko)) as Record<string, unknown>;
    (mutated.agentRuns as Record<string, unknown>).emptyTitle = '실행 기록이 없습니다.';
    const effectiveKeys = resolveEffectiveScopedKeys(mutated);
    const findings = findHonorificToneInScopedKeys(mutated, effectiveKeys);
    expect(findings).toContainEqual({ key: 'agentRuns.emptyTitle', matches: ['습니다'], value: '실행 기록이 없습니다.' });
  });

  it('양성대조 — nav.switcherProjectSearchEmpty를 원래 합니다체로 되돌리면 RED가 된다(namespace 전량 승격 증명)', () => {
    expect(SCOPED_KEYS as readonly string[]).not.toContain('nav.switcherProjectSearchEmpty');
    const mutated = JSON.parse(JSON.stringify(ko)) as Record<string, unknown>;
    (mutated.nav as Record<string, unknown>).switcherProjectSearchEmpty = '일치하는 프로젝트가 없습니다';
    const effectiveKeys = resolveEffectiveScopedKeys(mutated);
    const findings = findHonorificToneInScopedKeys(mutated, effectiveKeys);
    expect(findings).toContainEqual({ key: 'nav.switcherProjectSearchEmpty', matches: ['습니다'], value: '일치하는 프로젝트가 없습니다' });
  });

  it('양성대조 — dashboard.ccClearTitle을 원래 합니다체로 되돌리면 RED가 된다(namespace 전량 승격 증명)', () => {
    expect(SCOPED_KEYS as readonly string[]).not.toContain('dashboard.ccClearTitle');
    const mutated = JSON.parse(JSON.stringify(ko)) as Record<string, unknown>;
    (mutated.dashboard as Record<string, unknown>).ccClearTitle = '괜찮습니다';
    const effectiveKeys = resolveEffectiveScopedKeys(mutated);
    const findings = findHonorificToneInScopedKeys(mutated, effectiveKeys);
    expect(findings).toContainEqual({ key: 'dashboard.ccClearTitle', matches: ['습니다'], value: '괜찮습니다' });
  });

  // 양성대조(ㅂ니다 계열) — nav.orgLimitBannerTitle("필요합니다")로 NFD 처방이 이 세
  // 네임스페이스 승격에서도 실제로 작동하는지 확認(습니다 리터럴이 아닌 자리).
  it('양성대조 — nav.orgLimitBannerTitle(ㅂ니다 계열)를 원래 합니다체로 되돌리면 RED가 된다', () => {
    expect(SCOPED_KEYS as readonly string[]).not.toContain('nav.orgLimitBannerTitle');
    const mutated = JSON.parse(JSON.stringify(ko)) as Record<string, unknown>;
    (mutated.nav as Record<string, unknown>).orgLimitBannerTitle = '업그레이드가 필요합니다';
    const effectiveKeys = resolveEffectiveScopedKeys(mutated);
    const findings = findHonorificToneInScopedKeys(mutated, effectiveKeys);
    expect(findings).toContainEqual({ key: 'nav.orgLimitBannerTitle', matches: ['ㅂ니다'], value: '업그레이드가 필요합니다' });
  });

  it('무관 PR no-op — agentRuns·nav·dashboard 밖·SCOPED_KEYS 밖의 실 합니다체 키는 namespace 전량 승격 뒤에도 안 본다', () => {
    const outOfScopeValue = (ko.board as Record<string, unknown> | undefined)?.epicSwimlaneLoadError;
    expect(typeof outOfScopeValue).toBe('string');
    expect(outOfScopeValue as string).toMatch(/습니다|ㅂ니다|십시오/);
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    expect(effectiveKeys).not.toContain('board.epicSwimlaneLoadError');
    expect(findHonorificToneInScopedKeys(ko, effectiveKeys)).toEqual([]);
  });
});

// story #3921 — verifyEmail·setPassword 네임스페이스 전량 검증은 별도 파일
// verify-scoped-i18n-honorific-tone.3921.test.ts로 분리(페드루 PO 2차 지시, 2026-09-15
// — 병렬 append PR 다수라 이 공유 파일에 블록을 덧붙이면 구조적으로 충돌 재발).

// ---------------------------------------------------------------------------
// story #3901 — onboarding·login·storage·insightsBoard 네임스페이스 전량
// (SCOPED_NAMESPACES 승격). chats(#3885)·content/channelConnect(#3889)·settings(#3892)·
// agents/flow/gateConfig(#3895)·recruiter/loops/cage(#3899)와 정확히 같은 3형 검증
// (0건·양성대조·무관 PR no-op).
// ---------------------------------------------------------------------------

describe('실 ko.json — onboarding·login·storage·insightsBoard 네임스페이스 전량(story #3901 AC1/AC2)', () => {
  const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
  const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;

  it('SCOPED_KEYS+전 네임스페이스 전량(effective)의 ko.json 값에 합니다체 0건(story #3901 AC1 onboarding 27·login 17·storage 26·insightsBoard 25=95키 전량 이관 확認)', () => {
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    expect(effectiveKeys.length).toBeGreaterThan(SCOPED_KEYS.length);
    expect(findHonorificToneInScopedKeys(ko, effectiveKeys)).toEqual([]);
  });

  it('양성대조 — onboarding.createProjectFailed를 원래 합니다체로 되돌리면 RED가 된다(namespace 전량 승격 증명)', () => {
    expect(SCOPED_KEYS as readonly string[]).not.toContain('onboarding.createProjectFailed');
    const mutated = JSON.parse(JSON.stringify(ko)) as Record<string, unknown>;
    (mutated.onboarding as Record<string, unknown>).createProjectFailed = '프로젝트 생성에 실패했습니다';
    const effectiveKeys = resolveEffectiveScopedKeys(mutated);
    const findings = findHonorificToneInScopedKeys(mutated, effectiveKeys);
    expect(findings).toContainEqual({ key: 'onboarding.createProjectFailed', matches: ['습니다'], value: '프로젝트 생성에 실패했습니다' });
  });

  it('양성대조 — login.loginInvalidCredentials를 원래 합니다체로 되돌리면 RED가 된다(namespace 전량 승격 증명)', () => {
    expect(SCOPED_KEYS as readonly string[]).not.toContain('login.loginInvalidCredentials');
    const mutated = JSON.parse(JSON.stringify(ko)) as Record<string, unknown>;
    (mutated.login as Record<string, unknown>).loginInvalidCredentials = '이메일 또는 비밀번호가 올바르지 않습니다.';
    const effectiveKeys = resolveEffectiveScopedKeys(mutated);
    const findings = findHonorificToneInScopedKeys(mutated, effectiveKeys);
    expect(findings).toContainEqual({ key: 'login.loginInvalidCredentials', matches: ['습니다'], value: '이메일 또는 비밀번호가 올바르지 않습니다.' });
  });

  it('양성대조 — storage.emptyTitle을 원래 합니다체로 되돌리면 RED가 된다(namespace 전량 승격 증명)', () => {
    expect(SCOPED_KEYS as readonly string[]).not.toContain('storage.emptyTitle');
    const mutated = JSON.parse(JSON.stringify(ko)) as Record<string, unknown>;
    (mutated.storage as Record<string, unknown>).emptyTitle = '아직 자산이 없습니다';
    const effectiveKeys = resolveEffectiveScopedKeys(mutated);
    const findings = findHonorificToneInScopedKeys(mutated, effectiveKeys);
    expect(findings).toContainEqual({ key: 'storage.emptyTitle', matches: ['습니다'], value: '아직 자산이 없습니다' });
  });

  it('양성대조 — insightsBoard.loadError를 원래 합니다체로 되돌리면 RED가 된다', () => {
    expect(SCOPED_KEYS as readonly string[]).not.toContain('insightsBoard.loadError');
    const mutated = JSON.parse(JSON.stringify(ko)) as Record<string, unknown>;
    (mutated.insightsBoard as Record<string, unknown>).loadError = '성과 보드를 불러오지 못했습니다.';
    const effectiveKeys = resolveEffectiveScopedKeys(mutated);
    const findings = findHonorificToneInScopedKeys(mutated, effectiveKeys);
    expect(findings).toContainEqual({ key: 'insightsBoard.loadError', matches: ['습니다'], value: '성과 보드를 불러오지 못했습니다.' });
  });

  // 양성대조(ㅂ니다 계열) — login.termsPrefix("동의하게 됩니다")로 NFD 처방이 이 네
  // 네임스페이스 승격에서도 실제로 작동하는지 확認(습니다 리터럴이 아닌 자리).
  it('양성대조 — login.termsPrefix(ㅂ니다 계열)를 원래 합니다체로 되돌리면 RED가 된다', () => {
    expect(SCOPED_KEYS as readonly string[]).not.toContain('login.termsPrefix');
    const mutated = JSON.parse(JSON.stringify(ko)) as Record<string, unknown>;
    (mutated.login as Record<string, unknown>).termsPrefix = '계속하면 다음에 동의하게 됩니다:';
    const effectiveKeys = resolveEffectiveScopedKeys(mutated);
    const findings = findHonorificToneInScopedKeys(mutated, effectiveKeys);
    expect(findings).toContainEqual({ key: 'login.termsPrefix', matches: ['ㅂ니다'], value: '계속하면 다음에 동의하게 됩니다:' });
  });

  it('무관 PR no-op — onboarding·login·storage·insightsBoard 밖·SCOPED_KEYS 밖의 실 합니다체 키는 namespace 전량 승격 뒤에도 안 본다', () => {
    const outOfScopeValue = (ko.board as Record<string, unknown> | undefined)?.epicSwimlaneLoadError;
    expect(typeof outOfScopeValue).toBe('string');
    expect(outOfScopeValue as string).toMatch(/습니다|ㅂ니다|십시오/);
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    expect(effectiveKeys).not.toContain('board.epicSwimlaneLoadError');
    expect(findHonorificToneInScopedKeys(ko, effectiveKeys)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// story #3912 — usage·invite·meeting·supportWidget 네임스페이스 전량
// (SCOPED_NAMESPACES 승격). chats(#3885)·content/channelConnect(#3889)·settings(#3892)·
// agents/flow/gateConfig(#3895)·recruiter/loops/cage(#3899)·onboarding/login/storage/
// insightsBoard(#3901)와 정확히 같은 3형 검증(0건·양성대조·무관 PR no-op).
// ---------------------------------------------------------------------------

describe('실 ko.json — usage·invite·meeting·supportWidget 네임스페이스 전량(story #3912 AC1/AC2)', () => {
  const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
  const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;

  it('SCOPED_KEYS+전 네임스페이스 전량(effective)의 ko.json 값에 합니다체 0건(story #3912 AC1 usage 13·invite 11·meeting 11·supportWidget 10=45키 전량 이관 확認)', () => {
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    expect(effectiveKeys.length).toBeGreaterThan(SCOPED_KEYS.length);
    expect(findHonorificToneInScopedKeys(ko, effectiveKeys)).toEqual([]);
  });

  it('양성대조 — usage.noUsage를 원래 합니다체로 되돌리면 RED가 된다(namespace 전량 승격 증명)', () => {
    expect(SCOPED_KEYS as readonly string[]).not.toContain('usage.noUsage');
    const mutated = JSON.parse(JSON.stringify(ko)) as Record<string, unknown>;
    (mutated.usage as Record<string, unknown>).noUsage = '이번 달 사용량 데이터가 없습니다';
    const effectiveKeys = resolveEffectiveScopedKeys(mutated);
    const findings = findHonorificToneInScopedKeys(mutated, effectiveKeys);
    expect(findings).toContainEqual({ key: 'usage.noUsage', matches: ['습니다'], value: '이번 달 사용량 데이터가 없습니다' });
  });

  it('양성대조 — invite.inviteNotFound를 원래 합니다체로 되돌리면 RED가 된다(namespace 전량 승격 증명)', () => {
    expect(SCOPED_KEYS as readonly string[]).not.toContain('invite.inviteNotFound');
    const mutated = JSON.parse(JSON.stringify(ko)) as Record<string, unknown>;
    (mutated.invite as Record<string, unknown>).inviteNotFound = '초대를 찾을 수 없습니다.';
    const effectiveKeys = resolveEffectiveScopedKeys(mutated);
    const findings = findHonorificToneInScopedKeys(mutated, effectiveKeys);
    expect(findings).toContainEqual({ key: 'invite.inviteNotFound', matches: ['습니다'], value: '초대를 찾을 수 없습니다.' });
  });

  it('양성대조 — meeting.noMeetings를 원래 합니다체로 되돌리면 RED가 된다(namespace 전량 승격 증명)', () => {
    expect(SCOPED_KEYS as readonly string[]).not.toContain('meeting.noMeetings');
    const mutated = JSON.parse(JSON.stringify(ko)) as Record<string, unknown>;
    (mutated.meeting as Record<string, unknown>).noMeetings = '회의록이 없습니다';
    const effectiveKeys = resolveEffectiveScopedKeys(mutated);
    const findings = findHonorificToneInScopedKeys(mutated, effectiveKeys);
    expect(findings).toContainEqual({ key: 'meeting.noMeetings', matches: ['습니다'], value: '회의록이 없습니다' });
  });

  it('양성대조 — supportWidget.errorTitle을 원래 합니다체로 되돌리면 RED가 된다(namespace 전량 승격 증명)', () => {
    expect(SCOPED_KEYS as readonly string[]).not.toContain('supportWidget.errorTitle');
    const mutated = JSON.parse(JSON.stringify(ko)) as Record<string, unknown>;
    (mutated.supportWidget as Record<string, unknown>).errorTitle = '연결에 실패했습니다';
    const effectiveKeys = resolveEffectiveScopedKeys(mutated);
    const findings = findHonorificToneInScopedKeys(mutated, effectiveKeys);
    expect(findings).toContainEqual({ key: 'supportWidget.errorTitle', matches: ['습니다'], value: '연결에 실패했습니다' });
  });

  // 양성대조(ㅂ니다 계열) — meeting.transcriptRequired("전사 텍스트가 필요합니다")로 NFD
  // 처방이 이 네 네임스페이스 승격에서도 실제로 작동하는지 확認(습니다 리터럴이 아닌 자리).
  it('양성대조 — meeting.transcriptRequired(ㅂ니다 계열)를 원래 합니다체로 되돌리면 RED가 된다', () => {
    expect(SCOPED_KEYS as readonly string[]).not.toContain('meeting.transcriptRequired');
    const mutated = JSON.parse(JSON.stringify(ko)) as Record<string, unknown>;
    (mutated.meeting as Record<string, unknown>).transcriptRequired = '전사 텍스트가 필요합니다';
    const effectiveKeys = resolveEffectiveScopedKeys(mutated);
    const findings = findHonorificToneInScopedKeys(mutated, effectiveKeys);
    expect(findings).toContainEqual({ key: 'meeting.transcriptRequired', matches: ['ㅂ니다'], value: '전사 텍스트가 필요합니다' });
  });

  it('무관 PR no-op — usage·invite·meeting·supportWidget 밖·SCOPED_KEYS 밖의 실 합니다체 키는 namespace 전량 승격 뒤에도 안 본다', () => {
    const outOfScopeValue = (ko.board as Record<string, unknown> | undefined)?.epicSwimlaneLoadError;
    expect(typeof outOfScopeValue).toBe('string');
    expect(outOfScopeValue as string).toMatch(/습니다|ㅂ니다|십시오/);
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    expect(effectiveKeys).not.toContain('board.epicSwimlaneLoadError');
    expect(findHonorificToneInScopedKeys(ko, effectiveKeys)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// story #3909 — canvas·docs 네임스페이스 전량(SCOPED_NAMESPACES 승격, honorific-scope/
// canvas.json·docs.json). chats(#3885)·content/channelConnect(#3889)·settings(#3892)·
// agents/flow/gateConfig(#3895)·recruiter/loops/cage(#3899)·onboarding/login/storage/
// insightsBoard(#3901)·usage/invite/meeting/supportWidget(#3912)와 정확히 같은 3형
// 검증(0건·양성대조·무관 PR no-op).
// ---------------------------------------------------------------------------

describe('실 ko.json — canvas·docs 네임스페이스 전량(story #3909 AC1/AC2)', () => {
  const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
  const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;

  it('SCOPED_KEYS+전 네임스페이스 전량(effective)의 ko.json 값에 합니다체 0건(story #3909 AC1 canvas 20·docs 21=41키 전량 이관 확認)', () => {
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    expect(effectiveKeys.length).toBeGreaterThan(SCOPED_KEYS.length);
    expect(findHonorificToneInScopedKeys(ko, effectiveKeys)).toEqual([]);
  });

  it('양성대조 — canvas.canvasEmptyContent를 원래 합니다체로 되돌리면 RED가 된다(namespace 전량 승격 증명)', () => {
    expect(SCOPED_KEYS as readonly string[]).not.toContain('canvas.canvasEmptyContent');
    const mutated = JSON.parse(JSON.stringify(ko)) as Record<string, unknown>;
    (mutated.canvas as Record<string, unknown>).canvasEmptyContent = '이 산출물에는 아직 콘텐츠가 없습니다';
    const effectiveKeys = resolveEffectiveScopedKeys(mutated);
    const findings = findHonorificToneInScopedKeys(mutated, effectiveKeys);
    expect(findings).toContainEqual({
      key: 'canvas.canvasEmptyContent', matches: ['습니다'], value: '이 산출물에는 아직 콘텐츠가 없습니다',
    });
  });

  it('양성대조 — docs.noDocs를 원래 합니다체로 되돌리면 RED가 된다(namespace 전량 승격 증명)', () => {
    expect(SCOPED_KEYS as readonly string[]).not.toContain('docs.noDocs');
    const mutated = JSON.parse(JSON.stringify(ko)) as Record<string, unknown>;
    (mutated.docs as Record<string, unknown>).noDocs = '문서가 없습니다';
    const effectiveKeys = resolveEffectiveScopedKeys(mutated);
    const findings = findHonorificToneInScopedKeys(mutated, effectiveKeys);
    expect(findings).toContainEqual({
      key: 'docs.noDocs', matches: ['습니다'], value: '문서가 없습니다',
    });
  });

  it('무관 PR no-op — canvas·docs 밖·SCOPED_KEYS 밖의 실 합니다체 키는 namespace 전량 승격 뒤에도 안 본다', () => {
    const outOfScopeValue = (ko.board as Record<string, unknown> | undefined)?.epicSwimlaneLoadError;
    expect(typeof outOfScopeValue).toBe('string');
    expect(outOfScopeValue as string).toMatch(/습니다|ㅂ니다|십시오/);
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    expect(effectiveKeys).not.toContain('board.epicSwimlaneLoadError');
    expect(findHonorificToneInScopedKeys(ko, effectiveKeys)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// story #3899 — recruiter·loops·cage 네임스페이스 전량(SCOPED_NAMESPACES 승격).
// chats(#3885)·content/channelConnect(#3889)·settings(#3892)와 정확히 같은 3형 검증
// (0건·양성대조·무관 PR no-op).
// ---------------------------------------------------------------------------

describe('실 ko.json — recruiter·loops·cage 네임스페이스 전량(story #3899 AC1/AC2)', () => {
  const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
  const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;

  it('SCOPED_KEYS+전 네임스페이스 전량(effective)의 ko.json 값에 합니다체 0건(story #3899 AC1 recruiter 36·loops 34·cage 29=99키 전량 이관 확認)', () => {
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    expect(effectiveKeys.length).toBeGreaterThan(SCOPED_KEYS.length);
    expect(findHonorificToneInScopedKeys(ko, effectiveKeys)).toEqual([]);
  });

  it('양성대조 — recruiter.roleSearchEmpty를 원래 합니다체로 되돌리면 RED가 된다(namespace 전량 승격 증명)', () => {
    expect(SCOPED_KEYS as readonly string[]).not.toContain('recruiter.roleSearchEmpty');
    const mutated = JSON.parse(JSON.stringify(ko)) as Record<string, unknown>;
    (mutated.recruiter as Record<string, unknown>).roleSearchEmpty = '검색 결과가 없습니다.';
    const effectiveKeys = resolveEffectiveScopedKeys(mutated);
    const findings = findHonorificToneInScopedKeys(mutated, effectiveKeys);
    expect(findings).toContainEqual({ key: 'recruiter.roleSearchEmpty', matches: ['습니다'], value: '검색 결과가 없습니다.' });
  });

  it('양성대조 — loops.decisionSuccess(ㅂ니다 없는 순수 습니다 계열)를 원래 합니다체로 되돌리면 RED가 된다(namespace 전량 승격 증명)', () => {
    expect(SCOPED_KEYS as readonly string[]).not.toContain('loops.decisionSuccess');
    const mutated = JSON.parse(JSON.stringify(ko)) as Record<string, unknown>;
    (mutated.loops as Record<string, unknown>).decisionSuccess = '슬롯을 확정했습니다.';
    const effectiveKeys = resolveEffectiveScopedKeys(mutated);
    const findings = findHonorificToneInScopedKeys(mutated, effectiveKeys);
    expect(findings).toContainEqual({ key: 'loops.decisionSuccess', matches: ['습니다'], value: '슬롯을 확정했습니다.' });
  });

  it('양성대조 — cage.gateInboxLoadError(ㅂ니다 계열 아님·순수 습니다)를 원래 합니다체로 되돌리면 RED가 된다(namespace 전량 승격 증명)', () => {
    expect(SCOPED_KEYS as readonly string[]).not.toContain('cage.gateInboxLoadError');
    const mutated = JSON.parse(JSON.stringify(ko)) as Record<string, unknown>;
    (mutated.cage as Record<string, unknown>).gateInboxLoadError = '결재 대기를 불러오지 못했습니다';
    const effectiveKeys = resolveEffectiveScopedKeys(mutated);
    const findings = findHonorificToneInScopedKeys(mutated, effectiveKeys);
    expect(findings).toContainEqual({ key: 'cage.gateInboxLoadError', matches: ['습니다'], value: '결재 대기를 불러오지 못했습니다' });
  });

  // 양성대조 — recruiter.equipKeyOnceLabel(ㅂ니다 계열: 표시됩니다)로 NFD 처방이 이
  // 세 네임스페이스 승격에서도 실제로 작동하는지 확認(습니다 리터럴이 아닌 자리).
  it('양성대조 — recruiter.equipKeyOnceLabel(ㅂ니다 계열)를 원래 합니다체로 되돌리면 RED가 된다', () => {
    expect(SCOPED_KEYS as readonly string[]).not.toContain('recruiter.equipKeyOnceLabel');
    const mutated = JSON.parse(JSON.stringify(ko)) as Record<string, unknown>;
    (mutated.recruiter as Record<string, unknown>).equipKeyOnceLabel = 'API Key — 지금만 표시됩니다.';
    const effectiveKeys = resolveEffectiveScopedKeys(mutated);
    const findings = findHonorificToneInScopedKeys(mutated, effectiveKeys);
    expect(findings).toContainEqual({ key: 'recruiter.equipKeyOnceLabel', matches: ['ㅂ니다'], value: 'API Key — 지금만 표시됩니다.' });
  });

  it('무관 PR no-op — recruiter·loops·cage 밖·SCOPED_KEYS 밖의 실 합니다체 키는 namespace 전량 승격 뒤에도 안 본다', () => {
    const outOfScopeValue = (ko.board as Record<string, unknown> | undefined)?.epicSwimlaneLoadError;
    expect(typeof outOfScopeValue).toBe('string');
    expect(outOfScopeValue as string).toMatch(/습니다|ㅂ니다|십시오/);
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    expect(effectiveKeys).not.toContain('board.epicSwimlaneLoadError');
    expect(findHonorificToneInScopedKeys(ko, effectiveKeys)).toEqual([]);
  });

  it('실 ko.json의 organization leaf 개수가 하한(190) 이상이다(실측 212)', () => {
    const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
    const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    const organizationLeafCount = effectiveKeys.filter((k) => k.startsWith('organization.')).length;
    expect(organizationLeafCount).toBeGreaterThanOrEqual(190);
  });

  it('실 ko.json의 pricingPlans leaf 개수가 하한(125) 이상이다(실측 141)', () => {
    const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
    const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    const pricingPlansLeafCount = effectiveKeys.filter((k) => k.startsWith('pricingPlans.')).length;
    expect(pricingPlansLeafCount).toBeGreaterThanOrEqual(125);
  });

  it('실 ko.json의 contentRules leaf 개수가 하한(70) 이상이다(실측 81)', () => {
    const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
    const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    const contentRulesLeafCount = effectiveKeys.filter((k) => k.startsWith('contentRules.')).length;
    expect(contentRulesLeafCount).toBeGreaterThanOrEqual(70);
  });
});

// ---------------------------------------------------------------------------
// story #3892 — settings 네임스페이스 전량(SCOPED_NAMESPACES 승격). chats(#3885)·
// content/channelConnect(#3889)와 정확히 같은 3형 검증(0건·양성대조·무관 PR no-op).
// ---------------------------------------------------------------------------

describe('실 ko.json — settings 네임스페이스 전량(story #3892 AC1/AC2)', () => {
  const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
  const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;

  it('SCOPED_KEYS+chats+content+channelConnect+settings 전량(effective)의 ko.json 값에 합니다체 0건(story #3892 AC1 170키 전량 이관 확認)', () => {
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    expect(effectiveKeys.length).toBeGreaterThan(SCOPED_KEYS.length);
    expect(findHonorificToneInScopedKeys(ko, effectiveKeys)).toEqual([]);
  });

  it('양성대조 — settings.linkedAccountsOnlyMethodTitle을 원래 합니다체로 되돌리면 RED가 된다(namespace 전량 승격 증명)', () => {
    expect(SCOPED_KEYS as readonly string[]).not.toContain('settings.linkedAccountsOnlyMethodTitle');
    const mutated = JSON.parse(JSON.stringify(ko)) as Record<string, unknown>;
    (mutated.settings as Record<string, unknown>).linkedAccountsOnlyMethodTitle = '현재 유일한 로그인 수단입니다';
    const effectiveKeys = resolveEffectiveScopedKeys(mutated);
    const findings = findHonorificToneInScopedKeys(mutated, effectiveKeys);
    expect(findings).toContainEqual({ key: 'settings.linkedAccountsOnlyMethodTitle', matches: ['ㅂ니다'], value: '현재 유일한 로그인 수단입니다' });
  });

  it('무관 PR no-op — settings 밖·SCOPED_KEYS 밖의 실 합니다체 키는 namespace 전량 승격 뒤에도 안 본다', () => {
    const outOfScopeValue = (ko.board as Record<string, unknown> | undefined)?.epicSwimlaneLoadError;
    expect(typeof outOfScopeValue).toBe('string');
    expect(outOfScopeValue as string).toMatch(/습니다|ㅂ니다|십시오/);
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    expect(effectiveKeys).not.toContain('board.epicSwimlaneLoadError');
    expect(findHonorificToneInScopedKeys(ko, effectiveKeys)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// story #3889 — content·channelConnect 네임스페이스 전량(SCOPED_NAMESPACES 승격).
// chats(#3885)와 정확히 같은 3형 검증(0건·양성대조·무관 PR no-op).
// ---------------------------------------------------------------------------

describe('실 ko.json — content·channelConnect 네임스페이스 전량(story #3889 AC1/AC2)', () => {
  const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
  const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;

  it('SCOPED_KEYS+chats+content+channelConnect 전량(effective)의 ko.json 값에 합니다체 0건(story #3889 AC1 271키 전량 이관 확認)', () => {
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    expect(effectiveKeys.length).toBeGreaterThan(SCOPED_KEYS.length);
    expect(findHonorificToneInScopedKeys(ko, effectiveKeys)).toEqual([]);
  });

  // 페드루 PO 지시(2026-09-14, AC2) — "양성대조=content.emptyTitle 되돌림 RED".
  it('양성대조 — content.emptyTitle을 원래 합니다체로 되돌리면 RED가 된다(namespace 전량 승격 증명)', () => {
    expect(SCOPED_KEYS as readonly string[]).not.toContain('content.emptyTitle');
    const mutated = JSON.parse(JSON.stringify(ko)) as Record<string, unknown>;
    (mutated.content as Record<string, unknown>).emptyTitle = '아직 초안이 없습니다';
    const effectiveKeys = resolveEffectiveScopedKeys(mutated);
    const findings = findHonorificToneInScopedKeys(mutated, effectiveKeys);
    expect(findings).toContainEqual({ key: 'content.emptyTitle', matches: ['습니다'], value: '아직 초안이 없습니다' });
  });

  it('양성대조 — channelConnect.channelNoConnections를 원래 합니다체로 되돌리면 RED가 된다(namespace 전량 승격 증명)', () => {
    expect(SCOPED_KEYS as readonly string[]).not.toContain('channelConnect.channelNoConnections');
    const mutated = JSON.parse(JSON.stringify(ko)) as Record<string, unknown>;
    (mutated.channelConnect as Record<string, unknown>).channelNoConnections = '연결된 계정이 없습니다.';
    const effectiveKeys = resolveEffectiveScopedKeys(mutated);
    const findings = findHonorificToneInScopedKeys(mutated, effectiveKeys);
    expect(findings).toContainEqual({ key: 'channelConnect.channelNoConnections', matches: ['습니다'], value: '연결된 계정이 없습니다.' });
  });

  it('무관 PR no-op — content·channelConnect 밖·SCOPED_KEYS 밖의 실 합니다체 키는 namespace 전량 승격 뒤에도 안 본다', () => {
    const outOfScopeValue = (ko.board as Record<string, unknown> | undefined)?.epicSwimlaneLoadError;
    expect(typeof outOfScopeValue).toBe('string');
    expect(outOfScopeValue as string).toMatch(/습니다|ㅂ니다|십시오/);
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    expect(effectiveKeys).not.toContain('board.epicSwimlaneLoadError');
    expect(findHonorificToneInScopedKeys(ko, effectiveKeys)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// story #3895 — agents·flow·gateConfig 네임스페이스 전량(SCOPED_NAMESPACES 승격).
// chats/content/channelConnect/settings와 정확히 같은 3형 검증(0건·양성대조·무관 PR no-op).
// ---------------------------------------------------------------------------

describe('실 ko.json — agents·flow·gateConfig 네임스페이스 전량(story #3895 AC1/AC2)', () => {
  const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
  const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;

  it('SCOPED_KEYS+7개 네임스페이스 전량(effective)의 ko.json 값에 합니다체 0건(story #3895 AC1 128키 전량 이관 확認)', () => {
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    expect(effectiveKeys.length).toBeGreaterThan(SCOPED_KEYS.length);
    expect(findHonorificToneInScopedKeys(ko, effectiveKeys)).toEqual([]);
  });

  it('양성대조 — agents.workflowNoHumans를 원래 합니다체로 되돌리면 RED가 된다(namespace 전량 승격 증명)', () => {
    expect(SCOPED_KEYS as readonly string[]).not.toContain('agents.workflowNoHumans');
    const mutated = JSON.parse(JSON.stringify(ko)) as Record<string, unknown>;
    (mutated.agents as Record<string, unknown>).workflowNoHumans = '이 프로젝트에 활성 사람 멤버가 아직 없습니다.';
    const effectiveKeys = resolveEffectiveScopedKeys(mutated);
    const findings = findHonorificToneInScopedKeys(mutated, effectiveKeys);
    expect(findings).toContainEqual({
      key: 'agents.workflowNoHumans', matches: ['습니다'], value: '이 프로젝트에 활성 사람 멤버가 아직 없습니다.',
    });
  });

  it('양성대조 — flow.earthFoldEmpty를 원래 합니다체로 되돌리면 RED가 된다(namespace 전량 승격 증명)', () => {
    expect(SCOPED_KEYS as readonly string[]).not.toContain('flow.earthFoldEmpty');
    const mutated = JSON.parse(JSON.stringify(ko)) as Record<string, unknown>;
    (mutated.flow as Record<string, unknown>).earthFoldEmpty = '아직 연결된 스토리가 없습니다';
    const effectiveKeys = resolveEffectiveScopedKeys(mutated);
    const findings = findHonorificToneInScopedKeys(mutated, effectiveKeys);
    expect(findings).toContainEqual({
      key: 'flow.earthFoldEmpty', matches: ['습니다'], value: '아직 연결된 스토리가 없습니다',
    });
  });

  it('양성대조 — gateConfig.saveFailed를 원래 합니다체로 되돌리면 RED가 된다(namespace 전량 승격 증명)', () => {
    expect(SCOPED_KEYS as readonly string[]).not.toContain('gateConfig.saveFailed');
    const mutated = JSON.parse(JSON.stringify(ko)) as Record<string, unknown>;
    (mutated.gateConfig as Record<string, unknown>).saveFailed = '저장에 실패했습니다.';
    const effectiveKeys = resolveEffectiveScopedKeys(mutated);
    const findings = findHonorificToneInScopedKeys(mutated, effectiveKeys);
    expect(findings).toContainEqual({
      key: 'gateConfig.saveFailed', matches: ['습니다'], value: '저장에 실패했습니다.',
    });
  });

  // story #3899(rebase, 2026-09-15) — 이 자리도 cage.gateDetailNotFound를 고정 fixture로
  // 썼으나, 3899가 cage를 SCOPED_NAMESPACES로 승격하며 그 값도 해요체로 이관(잔존 0)돼
  // 더 이상 "스코프 밖" 표본이 못 된다 — 위 SCOPED_KEYS describe 블록과 같은 자리
  // (board.epicSwimlaneLoadError)로 교체, 같은 구조의 표본 유지.
  it('무관 PR no-op — agents·flow·gateConfig 밖·SCOPED_KEYS 밖의 실 합니다체 키는 namespace 전량 승격 뒤에도 안 본다', () => {
    const outOfScopeValue = (ko.board as Record<string, unknown> | undefined)?.epicSwimlaneLoadError;
    expect(typeof outOfScopeValue).toBe('string');
    expect(outOfScopeValue as string).toMatch(/습니다|ㅂ니다|십시오/);
    const effectiveKeys = resolveEffectiveScopedKeys(ko);
    expect(effectiveKeys).not.toContain('board.epicSwimlaneLoadError');
    expect(findHonorificToneInScopedKeys(ko, effectiveKeys)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// story #3889 CHANGES 1(PO PR 코멘트, 2026-09-14 19:19Z) — 플레이스홀더 «값» 바로 뒤에
// 계사(예요/이에요)를 붙이면 런타임 값의 받침 유무에 따라 절반은 문법이 어긋난다(「입니다」
// 는 받침 무관이라 문제가 없었지만, 해요체 전환의 「예요/이에요」는 앞 음절 받침으로
// 갈린다 — 정적으로 알 수 없는 런타임 숫자/문자열 뒤엔 아예 계사를 안 붙이는 형으로
// 재작성해야 한다). content.channelPostsImageTooLarge 등 4키를 이 형으로 고쳤다 — 이
// 가드가 재발을 막는다.
// ---------------------------------------------------------------------------

describe('story #3889 CHANGES 1 — 플레이스홀더 값 뒤 계사(예요/이에요) 0', () => {
  const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
  const ko = JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;

  function collectLeafValues(obj: Record<string, unknown> | undefined, prefix: string): [string, string][] {
    if (!obj) return [];
    const out: [string, string][] = [];
    for (const [k, v] of Object.entries(obj)) {
      const full = `${prefix}.${k}`;
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        out.push(...collectLeafValues(v as Record<string, unknown>, full));
      } else if (typeof v === 'string') {
        out.push([full, v]);
      }
    }
    return out;
  }

  const PLACEHOLDER_COPULA_RE = /\}(예요|이에요)/;

  it('content·channelConnect·settings·agents·flow·gateConfig·recruiter·loops·cage·onboarding·login·storage·insightsBoard·usage·invite·meeting·supportWidget·canvas·docs 전 leaf에 "}예요"·"}이에요"(placeholder 바로 뒤 계사) 0건', () => {
    // story #3892 — 스캔 범위에 settings 추가. story #3895 — agents·flow·gateConfig 추가
    // (착수 전 사전 스캔 0건 확認·전환 뒤 재확認 — 3889 교훈 그대로 재적용).
    // story #3899 — 스캔 범위에 recruiter·loops·cage 추가(전환 전 사전 스캔에서도 0건
    // 확認했고, 이 가드로 재발도 막는다).
    // story #3901 — 스캔 범위에 onboarding·login·storage·insightsBoard 추가(같은 자).
    // story #3912 — 스캔 범위에 usage·invite·meeting·supportWidget 추가(usage는 한도/쿼터
    // 숫자 placeholder가 많아 특히 이 계사 함정 대상 — 전환 전·후 모두 0건 확認).
    // story #3909 — 스캔 범위에 canvas·docs 추가(같은 자 — 착수 전 사전 스캔 0건 확認).
    const values = [
      ...collectLeafValues(ko.content as Record<string, unknown>, 'content'),
      ...collectLeafValues(ko.channelConnect as Record<string, unknown>, 'channelConnect'),
      ...collectLeafValues(ko.settings as Record<string, unknown>, 'settings'),
      ...collectLeafValues(ko.agents as Record<string, unknown>, 'agents'),
      ...collectLeafValues(ko.flow as Record<string, unknown>, 'flow'),
      ...collectLeafValues(ko.gateConfig as Record<string, unknown>, 'gateConfig'),
      ...collectLeafValues(ko.recruiter as Record<string, unknown>, 'recruiter'),
      ...collectLeafValues(ko.loops as Record<string, unknown>, 'loops'),
      ...collectLeafValues(ko.cage as Record<string, unknown>, 'cage'),
      ...collectLeafValues(ko.onboarding as Record<string, unknown>, 'onboarding'),
      ...collectLeafValues(ko.login as Record<string, unknown>, 'login'),
      ...collectLeafValues(ko.storage as Record<string, unknown>, 'storage'),
      ...collectLeafValues(ko.insightsBoard as Record<string, unknown>, 'insightsBoard'),
      ...collectLeafValues(ko.usage as Record<string, unknown>, 'usage'),
      ...collectLeafValues(ko.invite as Record<string, unknown>, 'invite'),
      ...collectLeafValues(ko.meeting as Record<string, unknown>, 'meeting'),
      ...collectLeafValues(ko.supportWidget as Record<string, unknown>, 'supportWidget'),
      ...collectLeafValues(ko.canvas as Record<string, unknown>, 'canvas'),
      ...collectLeafValues(ko.docs as Record<string, unknown>, 'docs'),
    ];
    const violations = values.filter(([, v]) => PLACEHOLDER_COPULA_RE.test(v));
    expect(violations).toEqual([]);
  });

  it('양성대조 — channelPostsImageTooLarge를 원래(계사 형)로 되돌리면 RED가 된다', () => {
    const mutated = JSON.parse(JSON.stringify(ko)) as Record<string, unknown>;
    (mutated.content as Record<string, unknown>).channelPostsImageTooLarge =
      '{maxBytes} 이하만 첨부할 수 있는데 {sizeBytes}예요';
    const values = collectLeafValues(mutated.content as Record<string, unknown>, 'content');
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
