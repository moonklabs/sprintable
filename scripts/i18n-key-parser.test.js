// story #3156 — 공유 파서(i18n-key-parser.js) 회귀가드 정본. check-i18n-keys.test.js와
// i18n-key-coverage.test.ts에 각각 있던 중복 extractKeyUsages 테스트를 여기로 통합했다 —
// 파서 결함 수리는 이제 이 한 곳만 고치면 두 소비처(CI 스크립트·vitest) 모두에 반영된다.
import { describe, expect, it } from 'vitest';
import {
  flatten,
  stripComments,
  extractKeyUsages,
  extractHookBindings,
} from './i18n-key-parser.js';

describe('flatten — 2단 이상 중첩 dot-path 평탄화', () => {
  it('flattens arbitrarily deep nesting into dot-joined leaf paths', () => {
    const nested = { a: { b: { c: 'leaf1', d: 'leaf2' }, e: 'leaf3' }, f: 'leaf4' };
    expect(flatten(nested)).toEqual({
      'a.b.c': 'leaf1',
      'a.b.d': 'leaf2',
      'a.e': 'leaf3',
      f: 'leaf4',
    });
  });
});

describe('stripComments — 주석 제거·문자열/정규식 리터럴 보존', () => {
  it('// 라인 주석과 /* */ 블록 주석을 제거하되 문자열 내용은 보존한다', () => {
    const src = "const t = 1; // strip me\n/* block */ const s = '// not a comment';";
    const out = stripComments(src);
    expect(out).not.toContain('strip me');
    expect(out).not.toContain('block');
    expect(out).toContain("'// not a comment'");
  });

  it('story #3023 — 백틱을 포함한 정규식 리터럴이 그 뒤 //  주석 인식을 깨뜨리지 않는다', () => {
    const src = 'const RE = /`[^`\\n]*`/g;\n// real comment\nconst x = 1;';
    const out = stripComments(src);
    expect(out).not.toContain('real comment');
    expect(out).toContain('const x = 1;');
  });

  it('주석 안 예시 코드(t(\'title\') 등)는 실제 호출로 안 잡힌다(story #2164 오탐 재발가드)', () => {
    const src = "// old code: t('title')\nconst t = 1;";
    const out = stripComments(src);
    expect(out).not.toContain("t('title')");
  });
});

describe('extractKeyUsages — 멤버접근(`obj.t(...)`)은 로컬 t() 호출로 오귀속되지 않는다 (story #3149)', () => {
  it('바로 호출(`t(...)`)은 정상적으로 잡힌다', () => {
    expect(extractKeyUsages("t('title');", 't')).toEqual(['title']);
  });

  it('멤버접근(`acc.t(...)`)은 varName=t로 조회할 때 안 잡힌다(실제 재현: context-switcher-chip.tsx의 acc.t(...) vs 파일 자신의 useTranslations(\'nav\') t)', () => {
    expect(extractKeyUsages("acc.t('title');", 't')).toEqual([]);
  });

  it('한 파일에 로컬 t(...)와 멤버접근 acc.t(...)가 공존해도 로컬 호출만 잡힌다', () => {
    const content = "t('switcherMobileTriggerAria');\nacc.t('title');\nacc.t('signOutAll');";
    expect(extractKeyUsages(content, 't')).toEqual(['switcherMobileTriggerAria']);
  });

  it('식별자 끝에 우연히 걸리는 것도 여전히 안 잡힌다(워드바운더리 보존 — get(\'x\')의 t(\'x\')류)', () => {
    expect(extractKeyUsages("get('title');", 't')).toEqual([]);
  });

  it('점 표기 네임스페이스 키(settings.mcpConnections류)도 통째로 잡힌다', () => {
    expect(extractKeyUsages("t('settings.mcpConnections.title');", 't')).toEqual(['settings.mcpConnections.title']);
  });
});

describe('extractHookBindings — useTranslations/getTranslations 훅 바인딩 추출', () => {
  it('const 변수명 = useTranslations(ns) 패턴을 잡는다', () => {
    const map = extractHookBindings("const t = useTranslations('nav');");
    expect(map.get('t')).toBe('nav');
  });

  it('임의의 변수명(tc/th/tGlance 등)도 하드코딩 t 가정 없이 잡는다', () => {
    const map = extractHookBindings("const tGlance = useTranslations('glance');\nconst tc = useTranslations('common');");
    expect(map.get('tGlance')).toBe('glance');
    expect(map.get('tc')).toBe('common');
  });

  it('서버 컴포넌트 getTranslations(await 포함)도 useTranslations와 동형으로 잡는다', () => {
    const map = extractHookBindings("const t = await getTranslations('dashboard');");
    expect(map.get('t')).toBe('dashboard');
  });

  it('const가 아닌 대입(let/멤버 대입)은 안 잡는다(실사용 관례 — 오탐 방지)', () => {
    const map = extractHookBindings("let t = useTranslations('nav');");
    expect(map.size).toBe(0);
  });
});
