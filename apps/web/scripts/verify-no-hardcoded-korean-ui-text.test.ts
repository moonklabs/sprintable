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

// story #3937(2026-09-16, PO 승인) — EXEMPT_FILES(파일 단위)가 gate-evidence.tsx를
// blast-radius 넓게 껐던 것을 line/symbol 단위 `// i18n-exempt: <사유>` 마커로 좁혔다.
// 이 describe가 그 마커 자체의 계약(바로 앞줄·사유 필수·다른 자리는 그대로 걸림)을
// 고정한다 — «합성 한글 주입 → RED / 예외 자리 → GREEN»(AC3)을 scanContent 유닛
// 레벨로 검증(파일 I/O 없이 결정적·빠름, 위 founding-case describe의 실 트리 기법과는
// 다른 층위 — 여긴 마커 판정 로직 자체가 대상).
describe('scanContent — 라인 마커(// i18n-exempt: <사유>, story #3937)', () => {
  it('⭐마커가 바로 앞줄에 있으면 그 문자열만 면제된다', () => {
    const content = [
      "function f() {",
      "  // i18n-exempt: BE sentinel 계약값 — 번역하면 매치가 깨진다.",
      "  const SENTINEL = '미확認';",
      "  return SENTINEL;",
      "}",
    ].join('\n');
    expect(scanContent(content, 'fake.tsx')).toEqual([]);
  });

  it('양성대조 — 같은 파일의 마커 없는 다른 한글은 그대로 걸린다(RED)', () => {
    const content = [
      "function f() {",
      "  // i18n-exempt: BE sentinel 계약값 — 번역하면 매치가 깨진다.",
      "  const SENTINEL = '미확認';",
      "  const other = '합성 신규 한글';",
      "  return SENTINEL + other;",
      "}",
    ].join('\n');
    const v = scanContent(content, 'fake.tsx');
    expect(v).toHaveLength(1);
    expect(v[0]!.text).toBe('합성 신규 한글');
  });

  it('마커가 있어도 그 줄이 아니라 한 줄 더 위면 면제되지 않는다(«바로 앞줄»만)', () => {
    const content = [
      "// i18n-exempt: 너무 멀리 있는 마커 — 이 줄은 안 통한다.",
      "",
      "const SENTINEL = '미확認';",
    ].join('\n');
    const v = scanContent(content, 'fake.tsx');
    expect(v).toHaveLength(1);
    expect(v[0]!.text).toBe('미확認');
  });

  it('사유 없는 마커("i18n-exempt:" 뒤에 텍스트 없음)는 면제하지 않는다(AC1 "사유 필수")', () => {
    const content = [
      "// i18n-exempt:",
      "const SENTINEL = '미확認';",
    ].join('\n');
    const v = scanContent(content, 'fake.tsx');
    expect(v).toHaveLength(1);
    expect(v[0]!.text).toBe('미확認');
  });

  it('마커 문구가 실 라인 주석이 아니라 일반 문자열 리터럴 안에 우연히 있으면 면제되지 않는다(카디르 P2·페드루 CHANGES2 — 우회 재현됐던 자리)', () => {
    const content = [
      "const note = 'i18n-exempt: 이건 그냥 문자열이지 주석이 아니다';",
      "const SENTINEL = '미확認';",
    ].join('\n');
    const v = scanContent(content, 'fake.tsx');
    // note 리터럴 자신도 한글을 담은 일반 StringLiteral이라 별도로 걸린다(그 줄이
    // "// i18n-exempt:"로 시작하지 않으므로) — 이 테스트의 요지는 SENTINEL이
    // 면제되지 «않는다»는 것뿐이라 note 쪽 판정은 부수 확認으로 남긴다.
    expect(v.some((x) => x.text === '미확認')).toBe(true);
  });

  it('멀티라인 템플릿 리터럴 «안»의 "// i18n-exempt: …" 문구 바로 다음 줄 위반은 면제되지 않는다(카디르 재현식 그대로, 페드루 CHANGES3 — 원문 줄 스캔 반창고 두 번째 재발)', () => {
    const content = [
      'const template = `',
      '  // i18n-exempt: example`;',
      "const SENTINEL = '미확認';",
    ].join('\n');
    const v = scanContent(content, 'fake.tsx');
    expect(v.some((x) => x.text === '미확認')).toBe(true);
  });

  it('JSX children 텍스트("// i18n-exempt: …"로 보이는 JsxText) 다음 줄 위반은 면제되지 않는다(카디르 codex 4번째 재현, 페드루 CHANGES4)', () => {
    const content = [
      'const v = <div>',
      '// i18n-exempt: example',
      "{'미확認'}",
      '</div>;',
    ].join('\n');
    const v = scanContent(content, 'fake.tsx');
    expect(v.some((x) => x.text === '미확認')).toBe(true);
  });

  it('JSX children 텍스트 마커 다음 줄이 속성값 변형(<span title=...>)이어도 면제되지 않는다(CHANGES4 변형)', () => {
    const content = [
      'const v = <div>',
      '// i18n-exempt: example',
      "<span title='미확認' />",
      '</div>;',
    ].join('\n');
    const v = scanContent(content, 'fake.tsx');
    expect(v.some((x) => x.text === '미확認')).toBe(true);
  });

  it('실 gate-evidence.tsx — _UNCONFIRMED 상수는 마커로 면제되고 baseline·EXEMPT_FILES 밖에서도 GREEN이다', () => {
    const filePath = path.resolve(__dirname, '../src/components/cage/gate-evidence.tsx');
    const content = readFileSync(filePath, 'utf8');
    const relPath = 'components/cage/gate-evidence.tsx';
    expect(EXEMPT_FILES.has(relPath)).toBe(false);
    const v = scanContent(content, relPath);
    expect(v.some((x) => x.text === '미확認')).toBe(false);
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
    // story #3937(페드루 CI 리뷰) — 이전 커밋에서 .ts 스캔 경로 양성대조를 지우는
    // 일괄치환('fake.ts' → 'fake.tsx')에 이 자리가 실수로 같이 걸려 아래 .tsx 테스트와
    // 같은 케이스가 돼 있었다 — 원복.
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

// story #3741 ⑥ — 창건 사례(유나 08:46Z 전수, 원래는 chats/page.tsx:19 —
// `<EmptyState ... description="왼쪽에서 대화를 선택하세요" />`)로 자가 실제로 무언가를
// 재는지 확認한다(합성 문자열만으론 통과 의식이 된다).
//
// 이 표본을 둘러싼 판정 이력(그대로 남긴다 — 같은 자리에서 왜 세 번 바뀌었는지):
//   1차 처방 — 속성 축을 placeholder/title/alt/aria-* 4개로 못 박음(창건 사례의
//     `description`은 이 축 밖).
//   PO 판정 (b)(2026-09-09 12:41Z, 그라운딩 자기모순 발견 뒤) — 창건 사례가 가드 축
//     밖이라 이 가드의 검증 표본이 될 수 없다는 자기모순을 발견, 검증 표본을 축 ①②
//     「안」의 실 사례(docs-client-layout.tsx aria-label="닫기")로 잠시 교체.
//   PO 판정 (a)(2026-09-09 13:45Z, 유나 재실측 뒤) — 4축 밖 한글 속성이 레포 전체
//     3건/3파일뿐(재측정 비용 낮음 실측)이라 (b)의 전제가 무너짐 — 속성 이름 명단
//     자체를 버려(파일 머리 주석 「PO 판정 (a)」 참조) 창건 사례가 이제 가드 축
//     «안»에 든다. 검증 표본을 창건 사례로 원복.
//   story #3788(2026-09-10, 유나 定) — 창건 사례 그 자리(`chats/page.tsx`의
//     description="왼쪽에서 대화를 선택하세요")가 실제로 수리됐다(B-③, 「왼쪽에서」 같은
//     방향어 자체가 모바일 거짓이라 폐기·i18n 키로 이관). 창건 사례가 더는 살아있는
//     위반이 아니므로 자가진단 표본을 PO 판정 (b)가 이미 검증했던 같은 대체 실사례
//     (`docs-client-layout.tsx aria-label="닫기"`, 지금도 baseline에 살아있음)로 교체한다.
//   story #3788 rebase(2026-09-10 11:1x, develop 08107dc81 위) — 위 대체 실사례도 그 사이
//     #4132(3776 PR③)가 수리해 baseline stale로 걸렸다. 두 표본 모두 짧은 기간에 수리된
//     건 이 가드가 평소 빠르게 작동해 baseline이 빠르게 줄고 있다는 증거이지 결함이
//     아니다 — 표본은 그때그때 살아있는 실 위반으로 교체하는 것이 이 파일의 관례
//     (「합성 문자열만으론 통과 의식」이라는 원 취지가 여전히 우선). settings/page.tsx는
//     30여 건이 몰려 있어 단기간 완전 소진 위험이 낮은 자리로 표본을 옮긴다.
//   story #3923(2026-09-15) — 앞 표본(app/unsubscribe/page.tsx)이 이번엔 직접 이 스토리의
//   작업 대상이라 수리됐다(§⑤·i18n 밖 app/ 페이지 전수 전환). 다시 짧은 기간에 소진된
//   패턴 그대로 — 표본을 components/chat/file-viewer.tsx(FORMAT_LABEL 상수, 36건 몰림 —
//   단기 소진 위험 낮음)로 옮긴다.
//   story #3930 PR①(2026-09-16, 페드루 CI 리뷰) — 앞 표본(file-viewer.tsx FORMAT_LABEL
//   「이미지」)이 이번엔 직접 이 PR의 작업 대상(components/chat/* 78건 t() 전환)이라
//   수리됐다 — 세 번째 소진. 표본을 components/kanban/story-detail-panel.tsx(16건
//   몰림 — PR②③ 대상이나 즉시 착수 예정 아님)의 「라벨 없음」으로 옮긴다.
//   story #3930 PR③(2026-09-16) — 이번엔 PR③ 자신이 baseline 41→0(kanban·app·onboarding·
//   기타 전량)을 마감해 story-detail-panel.tsx의 「라벨 없음」까지 수리한다 — 네 번째
//   소진이자 「baseline에 남은 실 위반이 하나도 없다」는 첫 사례(레포 전체가 정말로
//   0건이면 옮겨갈 다음 실 파일 자체가 없다). 실 레포 파일에 의존하는 표본은 구조적으로
//   더 지속 가능하지 않다 — EXEMPT_FILES 자가만료 테스트(아래 describe)가 이미 쓰는
//   임시 디렉터리 합성 표본 기법(같은 파일 mkdtempSync)으로 이 표본도 옮긴다. 실 파일이
//   아니라 scanRepo가 실제로 한글을 재는지(계약)만 확認하므로 baseline 소진과 완전히
//   독립적이고, 앞으로 다시는 옮길 필요가 없다.
describe('창건 사례 — scanRepo가 실제로 한글 위반을 재는지(합성 표본, 실 파일 소진과 독립)', () => {
  // scanRepo는 MIN_EXPECTED_FILES(400) 미만이면 "잘못된 srcRoot" 자가진단으로 throw한다
  // (운영 오용 방지 안전장치) — 격리된 임시 디렉터리(파일 1개)로는 이 안전장치 자체에
  // 걸려 scanRepo를 못 부른다. 그래서 진짜 src 트리 안에 합성 파일 하나를 잠깐 심어
  // 실 전수 스캔(파일 수 조건 자동 충족)이 그 파일을 실제로 잡는지 본다 — 레포의 기존
  // 위반 중 어느 하나가 살아있는지에는 완전히 무관(finally에서 항상 걷어낸다).
  it('한글 JsxText가 있는 합성 파일은 scanRepo가 실제로 잡는다(실 src 트리에 임시 파일)', () => {
    const srcRoot = path.resolve(__dirname, '../src');
    const relPath = '__founding-case-temp__.tsx';
    const abs = path.join(srcRoot, relPath);
    writeFileSync(abs, "export function C() { return <p>합성 창건 사례 문구</p>; }");
    try {
      const violations = scanRepo(srcRoot);
      const hit = violations.find((v) => v.file === relPath && v.text === '합성 창건 사례 문구');
      expect(hit).toBeDefined();
    } finally {
      rmSync(abs, { force: true });
    }
  }, 3500);
});

describe('EXEMPT_FILES — 내부 도그푸드·약관(스토리 明示 ④)', () => {
  // story #3902 — 635·850·728·851·686ms 중 최댓값 851ms → ×3 ≈ 2553ms → 3000ms로 반올림.
  it('exempt로 등재된 파일은 위반이 있어도 스캔에서 완전히 제외된다', () => {
    const violations = scanRepo(path.resolve(__dirname, '../src'));
    for (const exempt of EXEMPT_FILES) {
      expect(violations.some((v) => v.file === exempt)).toBe(false);
    }
  }, 3000);
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
  // story #3930 PR①②③(2026-09-16) — 이 파일 첫 도입(#3741) 이래 baseline.size > 0을
  // 당연한 전제로 뒀으나, 원 197건 grandfather 전량을 t() 전환하며 baseline이 처음으로
  // 진짜 0에 도달했다(scanRepo 실측도 0건/0파일 — 창건 사례 자가진단이 별도 합성
  // 표본으로 이 부재와 독립적으로 검증). "0이면 안 된다"는 파일이 깨졌다는 뜻이
  // 아니라 빚이 다 갚혔다는 뜻일 수 있다.
  // story #3937(2026-09-16, 페드루 지적) — `baseline.size >= 0`은 Set.size가 항상
  // 음수가 아니므로 무슨 값이 와도 참인 항상-참 단언이었다(무엇을 깨도 안 잡음, 남길
  // 이유 없음). `loadBaseline()`은 파싱 실패·파일 없음을 전부 삼켜 빈 Set을 돌려주므로
  // (재사용 목적상 정당한 설계) 그 경유로는 "파일이 깨졌다"와 "진짜 0건이다"를
  // 구분 못 한다 — 이 테스트는 그 둘을 갈라야 하므로 raw JSON을 직접 파싱하고
  // `Array.isArray(keys)`로 구조를 확認한다(파싱 실패·keys 비-배열이면 여기서 throw).
  it('hardcoded-korean-ui-text-baseline.json은 파싱 가능하고 keys는 배열이며(0건이어도 유효) 있는 키는 전부 file::text 형식이다', () => {
    const raw = readFileSync(path.resolve(__dirname, 'hardcoded-korean-ui-text-baseline.json'), 'utf8');
    const parsed = JSON.parse(raw) as { keys?: unknown };
    expect(Array.isArray(parsed.keys)).toBe(true);
    for (const key of parsed.keys as unknown[]) {
      expect(typeof key).toBe('string');
      expect(key as string).toContain('::');
    }
  });
});
