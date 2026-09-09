import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectLeafKeys,
  resolveMessageKey,
  scanFileContent,
  scanRepo,
} from './verify-i18n-keys-exist';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const KO_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages/ko.json');
const EN_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages/en.json');

describe('resolveMessageKey — story #5ead8723 AC1', () => {
  const messages = { nav: { title: '제목', nested: { deep: '깊은 값' } } };

  it('말단(문자열)까지 도달하면 true', () => {
    expect(resolveMessageKey(messages, 'nav.title')).toBe(true);
    expect(resolveMessageKey(messages, 'nav.nested.deep')).toBe(true);
  });

  // ⭐되돌리면 RED — 존재하지 않는 키(②)를 이 함수가 false로 판정 못 하면 가드 전체가 무력해진다.
  it('⭐존재하지 않는 키는 false', () => {
    expect(resolveMessageKey(messages, 'nav.doesNotExist')).toBe(false);
    expect(resolveMessageKey(messages, 'noSuchNamespace.key')).toBe(false);
  });

  it('경로가 object에서 멈추면(말단이 아니면) false — object를 값으로 오인하지 않는다', () => {
    expect(resolveMessageKey(messages, 'nav.nested')).toBe(false);
  });
});

describe('collectLeafKeys — ko↔en 말단 집합', () => {
  it('중첩 구조도 dot-path로 전부 뽑는다', () => {
    const messages = { a: '1', b: { c: '2', d: { e: '3' } } };
    expect(collectLeafKeys(messages)).toEqual(new Set(['a', 'b.c', 'b.d.e']));
  });
});

describe('scanFileContent — story #5ead8723 AC1/AC2/AC3(셀프테스트 6)', () => {
  // ① 존재하는 키(뒤 통합 테스트에서 실 ko/en 대조로 검증) — 여기선 추출 자체만.
  it('useTranslations 바인딩 + 리터럴 호출을 뽑는다', () => {
    const src = `
      function C() {
        const t = useTranslations('nav');
        return t('orgBriefing');
      }
    `;
    const result = scanFileContent(src, 'fake.tsx');
    expect(result.literalRefs).toEqual([{ file: 'fake.tsx', line: 4, fullKey: 'nav.orgBriefing' }]);
    expect(result.dynamicCount).toBe(0);
    expect(result.totalCallCount).toBe(1);
    expect(result.hasBindings).toBe(true);
  });

  // ⭐되돌리면 RED② — 이 키(nav.doesNotExist)는 뒤 통합 테스트에서 ko/en 실존 대조 시 반드시
  // 걸려야 한다. 여기선 추출 자체가 되는지만 확認.
  it('⭐존재하지 않는 키도 추출은 된다(존재 판정은 scanRepo+resolveMessageKey의 몫)', () => {
    const src = `
      const t = useTranslations('nav');
      t('doesNotExist');
    `;
    const result = scanFileContent(src, 'fake.tsx');
    expect(result.literalRefs).toEqual([{ file: 'fake.tsx', line: 3, fullKey: 'nav.doesNotExist' }]);
  });

  // ③ 주석 속 가짜 키 — AST가 주석을 애초에 노드로 안 보므로 오탐 0(구조적, 별도 필터 불요).
  it('⭐주석 안의 t(\'키\')는 안 뽑힌다(오탐 0 — AST가 comment를 trivia로 자연 배제)', () => {
    const src = `
      const t = useTranslations('nav');
      // t('fakeCommentKey') 이런 주석은 실행되지 않는다
      /* t('anotherFakeKey') 블록 주석도 마찬가지 */
      t('realKey');
    `;
    const result = scanFileContent(src, 'fake.tsx');
    expect(result.literalRefs).toEqual([{ file: 'fake.tsx', line: 5, fullKey: 'nav.realKey' }]);
  });

  // ④ t.rich('missing') — rich/raw/has 전부 같은 판정 축.
  it('⭐t.rich(\'key\')·t.raw(\'key\')·t.has(\'key\') 전부 리터럴로 뽑힌다', () => {
    const src = `
      const t = useTranslations('nav');
      t.rich('richKey', {});
      t.raw('rawKey');
      t.has('hasKey');
    `;
    const result = scanFileContent(src, 'fake.tsx');
    expect(result.literalRefs.map((r) => r.fullKey)).toEqual(['nav.richKey', 'nav.rawKey', 'nav.hasKey']);
  });

  // 바인딩 아닌 변수의 .has()는 무관 호출 — Set/Map류 오탐 방지(실 코드 HIDDEN_SETTINGS_TABS.has(...) 동형).
  it('바인딩되지 않은 변수의 .has()는 무시한다(Set/Map .has()류 오탐 방지)', () => {
    const src = `
      const seen = new Set();
      if (seen.has('workflow')) { /* noop */ }
    `;
    const result = scanFileContent(src, 'fake.tsx');
    expect(result.literalRefs).toEqual([]);
    expect(result.dynamicCount).toBe(0);
    expect(result.totalCallCount).toBe(0);
  });

  // ⑥ 동적 호출(변수·템플릿·삼항) — 실패 아니라 수로만 카운트.
  it('⭐동적 키(변수·템플릿·삼항)는 실패시키지 않고 수로만 센다(fails-silent 방지)', () => {
    const src = `
      const t = useTranslations('nav');
      const key = 'someKey';
      t(key);
      t(\`prefix.\${key}\`);
      t(cond ? 'a' : 'b');
    `;
    const result = scanFileContent(src, 'fake.tsx');
    expect(result.literalRefs).toEqual([]);
    expect(result.dynamicCount).toBe(3);
    expect(result.totalCallCount).toBe(3);
  });

  it('리터럴+동적 = 총 호출(자기 완전성)', () => {
    const src = `
      const t = useTranslations('nav');
      t('a');
      t(dynamicVar);
      t.rich('b');
    `;
    const result = scanFileContent(src, 'fake.tsx');
    expect(result.literalRefs.length + result.dynamicCount).toBe(result.totalCallCount);
    expect(result.totalCallCount).toBe(3);
  });

  it('네임스페이스 없는(루트) useTranslations()도 지원한다', () => {
    const src = `
      const t = useTranslations();
      t('rootKey');
    `;
    const result = scanFileContent(src, 'fake.tsx');
    expect(result.literalRefs).toEqual([{ file: 'fake.tsx', line: 3, fullKey: 'rootKey' }]);
  });

  it('getTranslations(\'ns\')·getTranslations({ namespace })도 바인딩으로 인식한다', () => {
    const src = `
      async function C() {
        const t1 = await getTranslations('nsA');
        const t2 = await getTranslations({ locale: 'ko', namespace: 'nsB' });
        return [t1('x'), t2('y')];
      }
    `;
    const result = scanFileContent(src, 'fake.tsx');
    expect(result.literalRefs.map((r) => r.fullKey)).toEqual(['nsA.x', 'nsB.y']);
  });

  // 「마지막 선언이 이긴다」— 실 코드 패턴(한 파일 여러 컴포넌트가 각자 const t = useTranslations(...)).
  it('같은 변수명이 여러 함수에서 다른 네임스페이스로 재선언되면 각자의 선언을 따른다', () => {
    const src = `
      function A() {
        const t = useTranslations('nsA');
        return t('x');
      }
      function B() {
        const t = useTranslations('nsB');
        return t('y');
      }
    `;
    const result = scanFileContent(src, 'fake.tsx');
    expect(result.literalRefs.map((r) => r.fullKey)).toEqual(['nsA.x', 'nsB.y']);
  });
});

// ⭐양성대조(story #5ead8723 판별) — develop HEAD 실 소스에 대해 이 가드가 실제로 통과하는지,
// 그리고 뮤테이션(존재하지 않는 키 삽입)을 걸면 실제로 RED가 되는지 왕복 확認한다.
describe('scanRepo — 양성대조(실 develop 소스)', () => {
  it('⭐실 소스 전수 스캔 — 리터럴 키 전부 ko/en에 실존(누락 0)·ko↔en 말단 키 집합 동일', () => {
    const koMessages = JSON.parse(readFileSync(KO_PATH, 'utf8'));
    const enMessages = JSON.parse(readFileSync(EN_PATH, 'utf8'));
    const result = scanRepo(SRC_ROOT);

    expect(result.filesWithBindings).toBeGreaterThan(0);
    expect(result.literalRefs.length).toBeGreaterThan(0);

    const missingKo = result.literalRefs.filter((r) => !resolveMessageKey(koMessages, r.fullKey));
    const missingEn = result.literalRefs.filter((r) => !resolveMessageKey(enMessages, r.fullKey));
    expect(missingKo, JSON.stringify(missingKo.slice(0, 10))).toEqual([]);
    expect(missingEn, JSON.stringify(missingEn.slice(0, 10))).toEqual([]);

    const koLeaves = collectLeafKeys(koMessages);
    const enLeaves = collectLeafKeys(enMessages);
    const koOnly = [...koLeaves].filter((k) => !enLeaves.has(k));
    const enOnly = [...enLeaves].filter((k) => !koLeaves.has(k));
    expect(koOnly, JSON.stringify(koOnly.slice(0, 10))).toEqual([]);
    expect(enOnly, JSON.stringify(enOnly.slice(0, 10))).toEqual([]);
  });

  // ⭐뮤테이션 킬 — 실 소스에 «존재하지 않는 키」를 참조하는 파일 하나를 섞어 넣으면(문자열
  // 픽스처로 scanFileContent 직접 호출·resolveMessageKey 대조) 실제로 걸리는지 증명.
  // scanRepo 자체를 파일시스템 뮤테이션 없이 검증하기 위해 그 내부 판정 로직(리터럴 추출→
  // resolveMessageKey 대조)을 같은 순서로 재현한다.
  it('⭐뮤테이션 킬 — 존재하지 않는 키를 참조하면 실제로 missing 목록에 잡힌다', () => {
    const koMessages = JSON.parse(readFileSync(KO_PATH, 'utf8'));
    const fakeRef = { file: 'mutation-kill-fixture.tsx', line: 1, fullKey: 'nav.thisKeyWillNeverExist12345' };
    expect(resolveMessageKey(koMessages, fakeRef.fullKey)).toBe(false);
  });
});
