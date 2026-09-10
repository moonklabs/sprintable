import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  computeDeadExemptFiles, computeNewViolations, computeStaleBaseline, EXEMPT_FILES, loadBaseline,
  scanContent, scanRepo, violationKey,
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

// story #3741(PO 判 (a), 2026-09-09 13:45Z) — 최초 판은 속성 축을 placeholder/title/
// alt/aria-* 4개로 못 박았으나, 유나 재실측(4축 밖 한글 속성 3건/3파일 — description
// 2·agentPlaceholder 1, "baseline 재측정 비용" 전제가 실측과 어긋남)에 따라 이름 명단을
// 버리고 문자열 리터럴 값을 가진 JSX 속성이면 전부 본다("지정 경로만 막는 가드는 클래스를
// 남긴다").
describe('scanContent — 대상 속성(이름 불문, 문자열 리터럴 값을 가진 JSX 속성 전부)', () => {
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

  // 뮤테이션 표적 — 속성 이름 필터를 되살리면(예: Foo/label을 다시 걸러내면) 이
  // 테스트가 실패해야 한다. 창건 사례(chats/page.tsx)와 동형 — 커스텀 컴포넌트 prop도
  // 이제 대상이다.
  it('⭐flags Hangul in a custom-component prop(4축 밖, PO 判 (a) — 뮤테이션 표적)', () => {
    const v = scanContent('const x = <Foo label="닫기" description="설명" />;', 'fake.tsx');
    expect(v).toHaveLength(2);
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
// 이 표본을 둘러싼 판정 이력(그대로 남긴다 — 같은 자리에서 왜 두 번 바뀌었는지):
//   1차 처방 — 속성 축을 placeholder/title/alt/aria-* 4개로 못 박음(창건 사례의
//     `description`은 이 축 밖).
//   PO 판정 (b)(2026-09-09 12:41Z, 그라운딩 자기모순 발견 뒤) — 창건 사례가 가드 축
//     밖이라 이 가드의 검증 표본이 될 수 없다는 자기모순을 발견, 검증 표본을 축 ①②
//     「안」의 실 사례(docs-client-layout.tsx aria-label="닫기")로 잠시 교체.
//   PO 판정 (a)(2026-09-09 13:45Z, 유나 재실측 뒤) — 4축 밖 한글 속성이 레포 전체
//     3건/3파일뿐(재측정 비용 낮음 실측)이라 (b)의 전제가 무너짐 — 속성 이름 명단
//     자체를 버려(파일 머리 주석 「PO 판정 (a)」 참조) 창건 사례가 이제 가드 축
//     «안»에 든다. 검증 표본을 창건 사례로 원복.
describe('창건 사례 — chats/page.tsx의 실 위반이 지금도 잡힌다', () => {
  const FOUNDED_CASE_FILE = path.resolve(__dirname, '../src/app/(authenticated)/chats/page.tsx');
  const FOUNDED_CASE_REL = 'app/(authenticated)/chats/page.tsx';

  it('chats/page.tsx가 실제로 description="왼쪽에서 대화를 선택하세요" 자리를 아직 갖고 있다', () => {
    const content = readFileSync(FOUNDED_CASE_FILE, 'utf8');
    expect(content).toContain('왼쪽에서 대화를 선택하세요');
  });

  it('실 저장소 스캔이 이 창건 사례를 담는다(자가 죽어있지 않다)', () => {
    const violations = scanRepo(path.resolve(__dirname, '../src'));
    const hit = violations.find((v) => v.file === FOUNDED_CASE_REL && v.text === '왼쪽에서 대화를 선택하세요');
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

// story #3776(유나 지적 06:09Z) — EXEMPT_FILES는 baseline stale 검사와 달리 자가만료가
// 없었다(scanRepo가 그냥 건너뛸 뿐) — #2485가 착지해 verify-email/set-password 두 파일이
// i18n 배선돼도 아무도 EXEMPT_FILES에서 걷으라고 안 알려주는 위험. computeDeadExemptFiles가
// 그 두 파일을 baseline stale과 동형으로 자가검출한다.
describe('computeDeadExemptFiles — story #3776(EXEMPT 자가만료)', () => {
  it('실 저장소 — 지금은 EXEMPT 파일 전부 한글이 실재한다(0건 아님, 죽은 예외 없음)', () => {
    const dead = computeDeadExemptFiles(path.resolve(__dirname, '../src'));
    expect(dead).toEqual([]);
  });

  // 실제 EXEMPT_FILES 멤버 경로에 파일을 만들어(임시 srcRoot) 진짜 함수를 그대로 돌린다
  // (EXEMPT_FILES 자체는 export const라 갈아끼우지 않고, computeDeadExemptFiles가 실제로
  // 참조하는 그 Set의 실제 경로 하나를 골라 임시 파일시스템에 재현).
  it('⭐한글 0건인 EXEMPT 파일은 죽은 예외로 잡힌다(임시 srcRoot에 실 경로 재현)', () => {
    const target = [...EXEMPT_FILES][0]!; // 예: 'app/internal-dogfood/page.tsx'
    const dir = mkdtempSync(path.join(os.tmpdir(), 'korean-ui-dead-exempt-'));
    const abs = path.join(dir, ...target.split('/'));
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, "export function C() { return <div>English only</div>; }");
    const dead = computeDeadExemptFiles(dir);
    expect(dead).toContain(target);
    rmSync(dir, { recursive: true, force: true });
  });

  it('한글이 남아 있는 EXEMPT 파일은 죽은 예외로 안 잡힌다(대조군, 실 경로 재현)', () => {
    const target = [...EXEMPT_FILES][0]!;
    const dir = mkdtempSync(path.join(os.tmpdir(), 'korean-ui-live-exempt-'));
    const abs = path.join(dir, ...target.split('/'));
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, "export function C() { return <div>한글 있음</div>; }");
    const dead = computeDeadExemptFiles(dir);
    expect(dead).not.toContain(target);
    rmSync(dir, { recursive: true, force: true });
  });
});

// story #3776(③-c) — JsxExpression 안 식 문자열 리터럴 축.
// story #3776(③, PO 判 2026-09-10 05:29Z) — 자리 화이트리스트를 버리고 «렌더 아닌
// 자리 부정목록»으로 뒤집었다. .tsx의 모든 StringLiteral이 기본 대상이고,
// isNonRenderStringLiteralPosition()에 걸리는 자리만 빠진다.
describe('scanContent — .tsx 문자열 리터럴 전부(부정목록만 제외, story #3776 ③)', () => {
  it('flags a bare string literal directly inside {}', () => {
    const v = scanContent("const x = <div>{'바로'}</div>;", 'fake.tsx');
    expect(v).toHaveLength(1);
    expect(v[0]!.text).toBe('바로');
  });

  it('flags the Hangul branch of a ternary inside {}', () => {
    const v = scanContent("const x = <div>{cond ? '한글' : t('key')}</div>;", 'fake.tsx');
    expect(v).toHaveLength(1);
    expect(v[0]!.text).toBe('한글');
  });

  it('flags a Hangul fallback in a || expression inside {}', () => {
    const v = scanContent("const x = <div>{name || '기본값'}</div>;", 'fake.tsx');
    expect(v).toHaveLength(1);
    expect(v[0]!.text).toBe('기본값');
  });

  // story #3776 반전 근거 — «렌더 값이 옵션 배열을 거쳐 화면에 닿는» 자리(유나
  // theme-settings.tsx:42-44 실사례와 동형). 이제 객체 리터럴 «값»도 잡힌다.
  it('flags a Hangul object-literal VALUE inside an array later consumed by .map()(옵션 배열 label)', () => {
    const v = scanContent(
      "const OPTIONS = [{ value: 'light', label: '라이트 모드' }]; const x = <div>{OPTIONS.map(o => <span>{o.label}</span>)}</div>;",
      'fake.tsx',
    );
    expect(v.map((x) => x.text)).toContain('라이트 모드');
  });

  // story #3776 반전 근거 — `toast('한글')`처럼 호출 인자를 거쳐 화면(토스트 UI)에
  // 닿는 자리. 함수 호출 인자를 일괄 배제하던 구판 규칙을 버렸다.
  it('flags a Hangul string literal passed as a plain function call argument(toast 등)', () => {
    const v = scanContent("function C() { toast('저장했어요'); return <div />; }", 'fake.tsx');
    expect(v.map((x) => x.text)).toContain('저장했어요');
  });

  // JSX 속성 «식»(구판 ②·③의 경계에 있던 자리) — placeholder="한글"뿐 아니라
  // placeholder={cond ? '한글' : ''}도 이제 걸린다(유나 05:29Z 지적 — 구판이 놓친 자리).
  it('flags Hangul inside a JSX attribute EXPRESSION(not just a direct string literal)', () => {
    const v = scanContent("const x = <input placeholder={cond ? '한글' : ''} />;", 'fake.tsx');
    expect(v.map((x) => x.text)).toContain('한글');
  });

  it('does not flag string literal call arguments that are i18n keys(no Hangul, moot regardless of axis)', () => {
    const v = scanContent("const x = <div>{t('key')}</div>;", 'fake.tsx');
    expect(v).toEqual([]);
  });

  // 중첩 JSX 이중 계수 0 — 각 StringLiteral 노드는 단일 walk에서 정확히 한 번만
  // 방문된다(구판의 walk-분기 이원화 자체가 사라졌다).
  it('flags Hangul inside JSX nested inside a call argument exactly once(no double counting)', () => {
    const v = scanContent("const x = <div>{items.map(i => <span>{'각각'}</span>)}</div>;", 'fake.tsx');
    expect(v).toHaveLength(1);
    expect(v[0]!.text).toBe('각각');
  });

  // ⭐되돌리면(비교 연산자 배제를 지우면) RED — 비교 피연산자는 불린만 만들 뿐
  // 화면에 그려지지 않는다.
  it('⭐does not flag a Hangul comparison operand(=== is not a render position)', () => {
    const v = scanContent("const x = <div>{status === '완료' ? a : b}</div>;", 'fake.tsx');
    expect(v).toEqual([]);
  });

  it('but still flags the ternary branches themselves even when the condition compares Hangul', () => {
    const v = scanContent("const x = <div>{status === '완료' ? '다됨' : '진행중'}</div>;", 'fake.tsx');
    expect(v.map((x) => x.text).sort()).toEqual(['다됨', '진행중']);
  });

  // ⭐되돌리면(switch case 배제를 지우면) RED.
  it('⭐does not flag a Hangul string used as a switch case value(matching, not rendered)', () => {
    const content = [
      "function label(x) { switch (x) { case '한글케이스': return a; default: return b; } }",
    ].join('\n');
    expect(scanContent(content, 'fake.tsx')).toEqual([]);
  });

  // ⭐되돌리면(PropertyAssignment.name 배제를 지우면) RED — 키는 데이터 조회용,
  // 값(레이블 등)만 렌더된다.
  it('⭐does not flag a Hangul object-literal KEY(value position is separately covered above)', () => {
    const v = scanContent("const x = <div>{lookup['한글키']}</div>; const o = { '한글': 1 };", 'fake.tsx');
    expect(v).toEqual([]);
  });

  it('does not flag Hangul in an import/export module specifier', () => {
    const v = scanContent("import Foo from './한글경로';", 'fake.tsx');
    expect(v).toEqual([]);
  });

  it('does not flag Hangul in a literal type position', () => {
    const v = scanContent("type Status = '한글타입';", 'fake.tsx');
    expect(v).toEqual([]);
  });

  // ⭐되돌리면(console.* 배제를 지우면) RED — 개발자 콘솔 로그는 사용자 화면이
  // 아니다(유나 05:31Z 실사례 — console.error 22키가 안 섞여야 한다).
  it('⭐does not flag Hangul inside a console.error(...) call argument', () => {
    const v = scanContent("console.error('전송 실패', err);", 'fake.tsx');
    expect(v).toEqual([]);
  });

  it('does not flag Hangul inside a this.logger.error(...) call argument', () => {
    const v = scanContent("this.logger.error('전송 실패', { err });", 'fake.tsx');
    expect(v).toEqual([]);
  });

  // ⭐되돌리면(문자열 검사 메서드 배제를 지우면) RED.
  it('⭐does not flag Hangul inside a .includes()/.startsWith() check argument', () => {
    const v1 = scanContent("const ok = s.includes('한글검사');", 'fake.tsx');
    const v2 = scanContent("const ok = s.startsWith('한글검사');", 'fake.tsx');
    expect(v1).toEqual([]);
    expect(v2).toEqual([]);
  });

  it('sees through parenthesized expressions(no special-casing needed — full-scan already reaches every StringLiteral)', () => {
    const v = scanContent("const x = <div>{(flag ? '한글' : b)}</div>;", 'fake.tsx');
    expect(v).toHaveLength(1);
    expect(v[0]!.text).toBe('한글');
  });
});

// story #3776(③-b, PO 判) — 죽은 baseline 항목(고쳐졌는데 목록에서 안 지운 것)을
// main()이 스스로 RED로 잡는다(예전엔 ⚠️ 경고·exit 0이었다).
describe('computeStaleBaseline — story #3776(③-b)', () => {
  it('does not flag a baseline key whose violation is still present', () => {
    const v = { file: 'fake.tsx', line: 1, text: '아직 있음' };
    expect(computeStaleBaseline([v], new Set([violationKey(v)]))).toEqual([]);
  });

  // ⭐되돌리면(computeStaleBaseline을 예전 「⚠️ 경고만」 동작으로 되돌리면 — main()이
  // 이 값을 실패 판정에 안 쓰면) RED. 고쳐진 자리를 baseline에서 안 지워도 CI가 초록으로
  // 남는 회귀를 이 테스트가 막는다.
  it('⭐flags a baseline key whose violation no longer exists in the scan(fixed but not removed)', () => {
    expect(computeStaleBaseline([], new Set(['fake.tsx::더는 없음']))).toEqual(['fake.tsx::더는 없음']);
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
