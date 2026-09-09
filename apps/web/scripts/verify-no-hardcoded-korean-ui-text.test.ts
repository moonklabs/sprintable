import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  computeNewViolations, EXEMPT_FILES, loadBaseline, scanContent, scanRepo, violationKey,
} from './verify-no-hardcoded-korean-ui-text';

describe('scanContent — JsxText', () => {
  it('flags visible Hangul text between JSX tags', () => {
    const content = "function C() { return <p>왼쪽에서 대화를 선택하세요</p>; }";
    const v = scanContent(content, 'fake.tsx');
    expect(v).toHaveLength(1);
    expect(v[0]!.text).toBe('왼쪽에서 대화를 선택하세요');
  });

  it('does not flag English-only JSX text', () => {
    expect(scanContent("function C() { return <p>Select a chat</p>; }", 'fake.tsx')).toEqual([]);
  });

  it('does not flag t(...) call results(dynamic, not a literal)', () => {
    const content = "function C() { const t = useTranslations(); return <p>{t('title')}</p>; }";
    expect(scanContent(content, 'fake.tsx')).toEqual([]);
  });
});

describe('scanContent — 대상 속성(placeholder/title/alt/aria-*)', () => {
  it('flags Hangul in placeholder', () => {
    const v = scanContent('const x = <input placeholder="이름을 입력하세요" />;', 'fake.tsx');
    expect(v).toHaveLength(1);
  });

  it('flags Hangul in title', () => {
    const v = scanContent('const x = <button title="닫기" />;', 'fake.tsx');
    expect(v).toHaveLength(1);
  });

  it('flags Hangul in alt', () => {
    const v = scanContent('const x = <img alt="프로필 사진" />;', 'fake.tsx');
    expect(v).toHaveLength(1);
  });

  it('flags Hangul in any aria-* attribute', () => {
    const v = scanContent('const x = <button aria-label="닫기 버튼" />;', 'fake.tsx');
    expect(v).toHaveLength(1);
  });

  it('does not flag other attribute names(스토리 明示 4축 밖, ㉢)', () => {
    const v = scanContent('const x = <Foo label="닫기" />;', 'fake.tsx');
    expect(v).toEqual([]);
  });

  it('does not flag an attribute whose value is a dynamic expression, not a string literal', () => {
    const v = scanContent('const x = <input placeholder={dynamicLabel} />;', 'fake.tsx');
    expect(v).toEqual([]);
  });
});

// story #3741 ① — 주석은 AST 노드가 아니라 trivia라 walk가 구조적으로 건너뛴다(별도
// 벗기기 불필요). 이 저장소 주석은 한글 천지라 여기서 잡히면 즉시 수천 건 오탐이 난다.
describe('scanContent — 주석은 절대 안 걸린다(① AST 구조적 배제)', () => {
  it('a Korean block comment above a component is not flagged', () => {
    const content = [
      '/**',
      ' * story #1234 — 이 주석은 순 한글이다. 걸리면 안 된다.',
      ' */',
      "function C() { return <p>English only</p>; }",
    ].join('\n');
    expect(scanContent(content, 'fake.tsx')).toEqual([]);
  });

  it('a Korean line comment inside a function body is not flagged', () => {
    const content = [
      "function C() {",
      "  // 이것도 한글 주석이다",
      "  return <p>English only</p>;",
      "}",
    ].join('\n');
    expect(scanContent(content, 'fake.tsx')).toEqual([]);
  });
});

// story #3741 ③ — .ts 파일은 ScriptKind.TS로 파싱해 제네릭의 `<...>`가 JSX로 오인되지
// 않는다(유나 첫 판 실 오탐 원인). 이 재현은 실제로 .ts 확장자로 스캔해야 의미가 있다
// (scanContent의 두 번째 인자 파일명이 .tsx인지 .ts인지로 파서 모드가 갈린다).
describe('scanContent — ③ .ts 파일의 제네릭은 JSX로 오인되지 않는다', () => {
  it('a Record<string, X> generic type annotation in a .ts file is not flagged', () => {
    const content = 'const 매핑: Record<string, number> = {};';
    // 변수명 자체에 한글이 섞여도(식별자는 JsxText/JsxAttribute가 아니라 애초에 대상 밖)
    // 제네릭의 `<...>`가 JSX로 잘못 파싱되지만 않으면 이 케이스는 통과해야 한다.
    expect(scanContent(content, 'fake.ts')).toEqual([]);
  });

  it('the same generic-heavy content parsed as .tsx is still safe(no JsxText exists to flag)', () => {
    const content = 'const x: Record<string, number> = {};';
    expect(scanContent(content, 'fake.tsx')).toEqual([]);
  });
});

describe('scanRepo — self-assert(재료 소실 방지)', () => {
  it('throws when the scanned directory has too few files', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'korean-ui-empty-'));
    expect(() => scanRepo(dir)).toThrow(/개뿐.*가드가 헛돌고 있다/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('loadBaseline', () => {
  it('returns an empty set when the file does not exist', () => {
    expect(loadBaseline('/nonexistent/path/baseline.json').size).toBe(0);
  });

  it('round-trips a {keys: [...]} baseline', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'korean-ui-baseline-test-'));
    const file = path.join(dir, 'baseline.json');
    writeFileSync(file, JSON.stringify({ _comment: [], keys: ['fake.tsx::닫기'] }));
    expect(loadBaseline(file)).toEqual(new Set(['fake.tsx::닫기']));
    rmSync(dir, { recursive: true, force: true });
  });
});

// 페드루 PO 리뷰 관례(story #3164 PR#3580) — main()과 같은 computeNewViolations()를
// 그대로 불러 판정 로직 드리프트를 막는다.
describe('computeNewViolations', () => {
  it('flags a violation whose key is not in baseline', () => {
    const violations = [{ file: 'fake.tsx', line: 1, text: '새 문자열' }];
    expect(computeNewViolations(violations, new Set())).toEqual(violations);
  });

  it('does not flag a violation whose key is already in baseline', () => {
    const v = { file: 'fake.tsx', line: 1, text: '기존 문자열' };
    expect(computeNewViolations([v], new Set([violationKey(v)]))).toEqual([]);
  });
});

// story #3741 ⑥ — 창건 사례(유나 08:46Z 전수, chats/page.tsx:19 —
// `<EmptyState ... description="왼쪽에서 대화를 선택하세요" />`)로 자가 실제로 무언가를
// 재는지 확認한다(합성 문자열만으론 통과 의식이 된다).
//
// PO 판정(2026-09-09 12:41Z, 그라운딩 자기모순 발견 뒤) — 창건 사례 그 자리는 `description`
// (커스텀 EmptyState prop)에 박혀 있는데, 이 가드가 보는 축은 明示 ①JsxText·②placeholder/
// title/alt/aria-* 넷뿐(㉢ — 다른 속성은 후속 판 확장 대상, 지금은 안 본다). 즉 창건 사례
// 자체는 이 가드의 검증 표본이 될 수 없다(자기모순 — 안 보는 축의 자리를 "잡혀야 한다"고
// 요구하는 셈). 처방 (b) — 창건 사례는 위 발견 기록으로 문서에 남기고, 검증 표본은 축
// ①②「안」의 실 사례로 교체한다. 축 ②를 커스텀 prop까지 넓히는 안은 baseline 재측정
// 비용이 커 별건(적기만, 이 스토리 스코프 밖).
describe('실 사례(축 ②aria-label) — docs-client-layout.tsx의 실 위반이 지금도 잡힌다', () => {
  const REAL_CASE_FILE = path.resolve(
    __dirname,
    '../src/app/(authenticated)/[ws]/[proj]/docs/docs-client-layout.tsx',
  );
  const REAL_CASE_REL = 'app/(authenticated)/[ws]/[proj]/docs/docs-client-layout.tsx';

  it('docs-client-layout.tsx가 실제로 aria-label="닫기" 자리를 아직 갖고 있다', () => {
    const content = readFileSync(REAL_CASE_FILE, 'utf8');
    expect(content).toContain('aria-label="닫기"');
  });

  it('실 저장소 스캔이 이 실 사례를 담는다(자가 죽어있지 않다)', () => {
    const violations = scanRepo(path.resolve(__dirname, '../src'));
    const hit = violations.find((v) => v.file === REAL_CASE_REL && v.text === '닫기');
    expect(hit).toBeDefined();
  });
});

describe('EXEMPT_FILES — 내부 도그푸드·약관(스토리 明示 ④)', () => {
  it('exempt로 등재된 파일은 위반이 있어도 스캔에서 완전히 제외된다', () => {
    const violations = scanRepo(path.resolve(__dirname, '../src'));
    for (const exempt of EXEMPT_FILES) {
      expect(violations.some((v) => v.file === exempt)).toBe(false);
    }
  });
});

describe('실 저장소 baseline 파일 형식', () => {
  it('hardcoded-korean-ui-text-baseline.json은 파싱 가능하고 모든 키가 file::text 형식이다', () => {
    const baseline = loadBaseline(path.resolve(__dirname, 'hardcoded-korean-ui-text-baseline.json'));
    expect(baseline.size).toBeGreaterThan(0);
    for (const key of baseline) {
      expect(key).toContain('::');
    }
  });
});
