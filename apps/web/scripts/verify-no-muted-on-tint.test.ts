/**
 * story #3839(critical·2pt) 회귀가드 유닛 테스트 — no-new-alpha-text-foreground.test.ts와
 * 동형(카디르 QA 지적 관례): compareToBaseline 뮤테이션 표본(일치·초과·stale) + scanContent
 * JSX 검출 표본(같은 요소·깊은 자식·bg-muted 예외·조상 없음 예외) + cva variant 컴포넌트
 * 경계(카디르 QA 보강, 2026-09-14 05:30Z) + activation-checklist-banner.tsx **실 파일**
 * 문자열 치환 뮤테이션(AC2 — 합성 표본은 보조, 실 파일이 주 판정).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  analyzeTreeForTintCompleteness,
  buildComponentTintMap,
  compareToBaseline,
  extractCvaTintVariants,
  scanContent,
  scanTreeForTintCompleteness,
  type ComponentTintMap,
} from './verify-no-muted-on-tint';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const UI_DIR = path.join(SRC_ROOT, 'components/ui');

describe('compareToBaseline — story #3839', () => {
  it('일치(baseline과 실측 개수가 정확히 같음) — 초과 0·stale 0 (GREEN)', () => {
    const baseline = new Map([['a.tsx::muted-on-info-tint', 2]]);
    const actual = new Map([['a.tsx::muted-on-info-tint', 2]]);
    const { increased, stale } = compareToBaseline(actual, baseline);
    expect(increased).toEqual([]);
    expect(stale).toEqual([]);
  });

  // 카디르 지적 ① — 등재 항목을 고쳤는데 baseline 개수를 안 낮추면(실측이 등재값보다 적음)
  // stale로 잡혀야 한다.
  it('미달(고쳤는데 baseline을 안 낮춤) — stale 1건 (FAIL)', () => {
    const baseline = new Map([['a.tsx::muted-on-warning-tint', 1]]);
    const actual = new Map<string, number>();
    const { increased, stale } = compareToBaseline(actual, baseline);
    expect(increased).toEqual([]);
    expect(stale).toEqual([{ key: 'a.tsx::muted-on-warning-tint', expected: 1, got: 0 }]);
  });

  it('초과(같은 파일·같은 조합이 baseline보다 더 늘어남) — increased 1건 (FAIL)', () => {
    const baseline = new Map([['b.tsx::muted-on-destructive-tint', 1]]);
    const actual = new Map([['b.tsx::muted-on-destructive-tint', 2]]);
    const { increased, stale } = compareToBaseline(actual, baseline);
    expect(increased).toEqual([{ key: 'b.tsx::muted-on-destructive-tint', expected: 1, got: 2 }]);
    expect(stale).toEqual([]);
  });

  it('baseline에 없는 완전 신규 키가 실측에 나타나면 increased로 잡힌다', () => {
    const baseline = new Map<string, number>();
    const actual = new Map([['new-file.tsx::muted-on-success-tint', 1]]);
    const { increased, stale } = compareToBaseline(actual, baseline);
    expect(increased).toEqual([{ key: 'new-file.tsx::muted-on-success-tint', expected: 0, got: 1 }]);
    expect(stale).toEqual([]);
  });
});

describe('scanContent — JSX 구조 검출(리터럴 className 조상)', () => {
  it('조상 tint(bg-info-tint) 서브트리 안 text-muted-foreground를 잡는다(깊은 자식)', () => {
    const content = `
      <Alert variant="info" className="bg-info-tint">
        <ul>
          <li className="text-muted-foreground">아직 안 함</li>
        </ul>
      </Alert>
    `;
    const violations = scanContent(content, 'sample.tsx');
    expect(violations).toHaveLength(1);
    expect(violations[0]!.family).toBe('info');
  });

  it('같은 요소가 bg-{family}-tint와 text-muted-foreground를 동시에 가지면 잡는다', () => {
    const content = `<div className="bg-warning-tint text-muted-foreground">경고</div>`;
    const violations = scanContent(content, 'sample.tsx');
    expect(violations).toHaveLength(1);
    expect(violations[0]!.family).toBe('warning');
  });

  it('bg-muted 자체는 대상 밖(--muted-foreground의 calibrated 원래 짝)', () => {
    const content = `
      <div className="bg-muted">
        <p className="text-muted-foreground">본문</p>
      </div>
    `;
    expect(scanContent(content, 'sample.tsx')).toEqual([]);
  });

  it('tint 조상이 없으면(일반 배경) text-muted-foreground를 잡지 않는다', () => {
    const content = `<p className="text-muted-foreground">그냥 본문</p>`;
    expect(scanContent(content, 'sample.tsx')).toEqual([]);
  });

  it('tint 조상 서브트리라도 text-foreground는 잡지 않는다(정상)', () => {
    const content = `
      <Alert variant="info" className="bg-info-tint">
        <p className="text-foreground">정상 문구</p>
      </Alert>
    `;
    expect(scanContent(content, 'sample.tsx')).toEqual([]);
  });
});

// story #3839 카디르 QA 보강(2026-09-14 05:30Z) — 최초판은 리터럴 className만 봐서
// `<Alert variant="info">`처럼 tint가 cva variant 정의(컴포넌트 경계) 안에서만 나오는
// 자리를 못 잡았다(activation-checklist-banner.tsx 실사고 재현으로 적발). componentMap을
// 넘기면 그 경계도 리터럴 조상과 동일하게 취급해야 한다.
describe('scanContent — cva variant 컴포넌트 경계(카디르 QA 보강)', () => {
  const infoOnlyMap: ComponentTintMap = new Map([
    ['Alert', new Map([['variant', new Map([['info', 'info' as const]])]])],
  ]);

  it('componentMap에 등재된 <Alert variant="info">는 리터럴 bg-info-tint 조상과 동일하게 잡는다', () => {
    const content = `
      <Alert variant="info">
        <p className="text-muted-foreground">본문</p>
      </Alert>
    `;
    const violations = scanContent(content, 'sample.tsx', infoOnlyMap);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.family).toBe('info');
  });

  it('componentMap이 없으면(호출부가 안 넘기면) 같은 JSX도 못 잡는다 — 이게 카디르가 적발한 구멍', () => {
    const content = `
      <Alert variant="info">
        <p className="text-muted-foreground">본문</p>
      </Alert>
    `;
    expect(scanContent(content, 'sample.tsx')).toEqual([]);
  });

  it('componentMap에 없는 variant 값(success)은 안 잡는다(하드코딩 0 — 지도에 있는 것만)', () => {
    const content = `
      <Alert variant="success">
        <p className="text-muted-foreground">본문</p>
      </Alert>
    `;
    expect(scanContent(content, 'sample.tsx', infoOnlyMap)).toEqual([]);
  });

  it('동적 variant 값(리터럴 아님)은 「항상 적용 보장 안 됨」이라 안 잡는다(#2590 A와 동일 정밀성)', () => {
    const content = `
      <Alert variant={someVar}>
        <p className="text-muted-foreground">본문</p>
      </Alert>
    `;
    expect(scanContent(content, 'sample.tsx', infoOnlyMap)).toEqual([]);
  });
});

// story #3839 카디르 QA 보강 — cva() → 컴포넌트 지도 추출 자체의 정확성·완전성 fail-closed.
describe('extractCvaTintVariants — 추출 정확성·완전성', () => {
  it('실 alert.tsx: Alert.variant.{success,warning,destructive,info}가 각자 계열로 잡힌다(하드코딩 대조 아닌 실 파일 대조)', () => {
    const content = readFileSync(path.join(UI_DIR, 'alert.tsx'), 'utf8');
    const { map, incompleteReasons } = extractCvaTintVariants(content, 'components/ui/alert.tsx');
    expect(incompleteReasons).toEqual([]);
    const alertVariants = map.get('Alert')?.get('variant');
    expect(alertVariants?.get('success')).toBe('success');
    expect(alertVariants?.get('warning')).toBe('warning');
    expect(alertVariants?.get('destructive')).toBe('destructive');
    expect(alertVariants?.get('info')).toBe('info');
    // default variant는 bg-muted/40이라 tint 계열이 아니므로 지도에 없어야 한다(지어내지 않음).
    expect(alertVariants?.has('default')).toBe(false);
  });

  it('실 badge.tsx: Badge.variant.{destructive,success,info,warning}이 각자 계열로 잡힌다', () => {
    const content = readFileSync(path.join(UI_DIR, 'badge.tsx'), 'utf8');
    const { map, incompleteReasons } = extractCvaTintVariants(content, 'components/ui/badge.tsx');
    expect(incompleteReasons).toEqual([]);
    const badgeVariants = map.get('Badge')?.get('variant');
    expect(badgeVariants?.get('destructive')).toBe('destructive');
    expect(badgeVariants?.get('success')).toBe('success');
    expect(badgeVariants?.get('info')).toBe('info');
    expect(badgeVariants?.get('warning')).toBe('warning');
  });

  it('cva에 tint 클래스가 있는데 호출하는 컴포넌트를 못 찾으면(orphan) 완전성 fail-closed로 신고한다', () => {
    const content = `
      const orphanVariants = cva('base', {
        variants: { variant: { info: 'bg-info-tint text-foreground' } },
      });
      // orphanVariants를 쓰는 컴포넌트가 파일 안에 없다 — 지도로 못 옮겨짐.
    `;
    const { map, incompleteReasons } = extractCvaTintVariants(content, 'sample.tsx');
    expect(map.size).toBe(0);
    expect(incompleteReasons.length).toBeGreaterThan(0);
    expect(incompleteReasons[0]).toContain('orphanVariants');
  });

  it('cva variants 밖에 원시 tint 클래스가 더 있으면(구조화 추출이 못 옮김) 완전성 fail-closed로 신고한다', () => {
    const content = `
      const fooVariants = cva('base', {
        variants: { variant: { info: 'bg-info-tint text-foreground' } },
      });
      function Foo({ variant }) {
        return <div className={fooVariants({ variant })} data-extra="bg-warning-tint" />;
      }
    `;
    const { incompleteReasons } = extractCvaTintVariants(content, 'sample.tsx');
    expect(incompleteReasons.some((r) => r.includes('추출 완전성 fail-closed'))).toBe(true);
  });
});

describe('buildComponentTintMap — 실 components/ui 디렉터리 전수(완전성 fail-closed 0)', () => {
  it('실 UI_DIR 스캔이 incompleteReasons 0으로 끝난다(현재 develop 기준 — 모호한 cva 0)', () => {
    const { incompleteReasons } = buildComponentTintMap(UI_DIR);
    expect(incompleteReasons).toEqual([]);
  });
});

// story #3839 AC2(카디르 QA 지적, 2026-09-14 05:30Z) — "단위테스트도 실 파일 내용에 문자열
// 치환으로·합성 표본은 보조". activation-checklist-banner.tsx **실 파일**을 읽어, 고쳐진
// 형태가 0건인지·그중 실제로 한 곳을 되돌리면(원래 버그 패턴) RED가 되는지 실측한다 —
// 합성 표본(위 describe들)은 이 실 파일 판정의 보조일 뿐 주 판정이 아니다.
describe('scanContent — 실 파일 뮤테이션(activation-checklist-banner.tsx, AC2 주 판정)', () => {
  const REL_FILE = 'components/dashboard/activation-checklist-banner.tsx';
  const ABS_FILE = path.join(SRC_ROOT, REL_FILE);
  const { map: componentMap, incompleteReasons } = buildComponentTintMap(UI_DIR);
  const original = readFileSync(ABS_FILE, 'utf8');

  it('전제: componentMap 추출이 완전함(incompleteReasons 0) — 이래야 아래 판정을 신뢰할 수 있다', () => {
    expect(incompleteReasons).toEqual([]);
  });

  it('고쳐진 실 파일(develop HEAD, PR #4259 반영분) — 위반 0건', () => {
    expect(scanContent(original, REL_FILE, componentMap)).toEqual([]);
  });

  it('실 파일에서 한 곳(첫 번째 text-foreground 고정 자리)을 원래 버그로 되돌리면 RED', () => {
    const target = "'text-foreground',";
    expect(original.includes(target)).toBe(true);
    // 문자열 .replace는 첫 매치 1건만 바꾼다 — "한 곳"을 결정적으로 고른다.
    const mutated = original.replace(target, "met ? 'text-foreground' : 'text-muted-foreground',");
    expect(mutated).not.toBe(original);
    const violations = scanContent(mutated, REL_FILE, componentMap);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.family).toBe('info');
  });
});

// story #3839 PO 보강(2026-09-14 05:43·05:48Z) — 완전성 fail-closed를 components/ui/ 안이
// 아니라 스캔 트리 전체로 넓힌 뒤의 양성대조 2건: ① ui/ 밖 cva tint ② UNANALYZED_TINT_SITES
// 목록 밖 객체맵 tint. 둘 다 RED(=unexplainedSites에 잡힘)여야 한다 — "같은 메커니즘이
// ui/ 밖·하위 폴더에 생기면 가드가 조용히 못 보는" 구멍이 실제로 막혔는지 실측.
describe('analyzeTreeForTintCompleteness — 전 트리 양성대조(PO 보강)', () => {
  it('① ui/ 밖 파일의 cva tint는 "처리됨"으로 안 침(ui/ cva만 인정) — RED', () => {
    const files = [
      {
        file: 'components/foo/bar.tsx',
        content: `
          const barVariants = cva('base', {
            variants: { variant: { info: 'bg-info-tint text-foreground' } },
          });
          function Bar({ variant }) {
            return <div className={barVariants({ variant })} />;
          }
        `,
      },
    ];
    const { unexplainedSites, ambiguousReasons } = analyzeTreeForTintCompleteness(
      files,
      (file) => file.startsWith('components/ui/'),
    );
    // extractCvaTintVariants 자체는 Bar를 정확히 찾아 모호하지 않다(ambiguous 아님) —
    // 그런데도 ui/ 밖이라 explained에 안 실려야 한다(그게 이 보강의 핵심).
    expect(ambiguousReasons).toEqual([]);
    expect(unexplainedSites).toEqual([{ file: 'components/foo/bar.tsx', raw: 1, explained: 0 }]);
  });

  // story #3850(AC1 축 a) 착지 뒤 이 정확한 패턴(객체 맵 프로퍼티 조회)은 이제 explained —
  // #3839 당시 "가드가 구조적으로 못 보는 사각"이었던 자리가 #3850의 존재 이유대로 닫혔다.
  it('② 객체 맵 tint(status→className 조회)는 이제 explained(story #3850 AC1 축 a로 해소) — GREEN', () => {
    const files = [
      {
        file: 'components/foo/status-map.tsx',
        content: `
          const STATUS_META = {
            approved: { dot: 'bg-success-tint text-success' },
          };
          function Status({ status }) {
            return <span className={STATUS_META[status].dot} />;
          }
        `,
      },
    ];
    const { unexplainedSites } = analyzeTreeForTintCompleteness(files, () => false);
    expect(unexplainedSites).toEqual([]);
  });

  // story #3850 — 이 축 2개(객체 맵·삼항/템플릿)로도 여전히 못 보는 진짜 새 사각(switch문
  // 분기별 literal return)이 계속 RED로 잡히는지 확인한다 — completeness 게이트가 "뭐든 다
  // explained로 뭉개는" 퇴화를 하지 않았다는 음성대조(가드 신뢰성 확보, 이 스토리가 스스로
  // "축 2개만 닫는다"고 선언한 스코프를 지켰는지의 자체 증거).
  it('③ switch문 분기별 tint 리터럴은 여전히 unanalyzed(이 스토리가 다루는 축 밖) — RED', () => {
    const files = [
      {
        file: 'components/foo/switch-map.tsx',
        content: `
          function tintFor(status) {
            switch (status) {
              case 'approved': return 'bg-success-tint text-success';
              default: return 'bg-muted';
            }
          }
          function Status({ status }) {
            return <span className={tintFor(status)} />;
          }
        `,
      },
    ];
    const { unexplainedSites } = analyzeTreeForTintCompleteness(files, () => false);
    expect(unexplainedSites).toEqual([{ file: 'components/foo/switch-map.tsx', raw: 1, explained: 0 }]);
  });

  it('ui/ 안 리터럴 className tint는 정상 처리됨(대조군 — 0건이어야 함)', () => {
    const files = [{ file: 'components/ui/box.tsx', content: `function Box() { return <div className="bg-info-tint" />; }` }];
    const { unexplainedSites } = analyzeTreeForTintCompleteness(files, (file) => file.startsWith('components/ui/'));
    expect(unexplainedSites).toEqual([]);
  });
});

describe('scanTreeForTintCompleteness — 실 src 트리(UNANALYZED_TINT_SITES와 일치)', () => {
  // story #3902 — 부하 시 vitest 기본 5000ms를 넘길 수 있는 실 전수 스캔(측정: apps/web
  // 전체 스위트 동시부하 재현 5회 = 1654·1629·1695·2156·1547ms, scripts/ 디렉터리만 동시
  // 실행했을 때 5842ms까지 관측 — 이 파일은 `scan[A-Z]...` 명명(scanTreeForTintCompleteness)
  // 이라 story 착수 시 최초 grep(scanRepo|readdirSync)이 못 잡았다가, 전체 파일 재검토
  // 中 실제 RED 재현으로 뒤늦게 발견해 스코프에 편입). 최댓값 5842ms × 3 ≈ 17526ms →
  // 18000ms로 반올림.
  it('실 SRC_ROOT 스캔이 ambiguousReasons 0(모호한 cva 없음)', () => {
    const { ambiguousReasons } = scanTreeForTintCompleteness(SRC_ROOT, UI_DIR);
    expect(ambiguousReasons).toEqual([]);
  }, 18000);
});

// story #3850 AC3 — 신설 분석기 2축(객체 맵·삼항/템플릿 리터럴)이 실제로 JSX 조상 추적에
// 연결됐는지, activation-checklist-banner.tsx(story #3839 AC2)와 동형으로 **실 파일**
// 문자열 치환 뮤테이션으로 확인한다(합성 표본은 위 describe들에서 이미 보조로 다룸).
describe('scanContent — 실 파일 뮤테이션(story #3850 AC3, 신설 분석기 2축)', () => {
  const { map: componentMap, incompleteReasons } = buildComponentTintMap(UI_DIR);

  it('전제: componentMap 추출이 완전함(incompleteReasons 0)', () => {
    expect(incompleteReasons).toEqual([]);
  });

  // 축 (a) 객체 맵 — doc-gate-section.tsx의 AUDIT_META(status→{dot,Icon,labelKey}) 프로퍼티
  // 조회가 className에 들어가는 실 자리(438행 `${am.dot}` span). 그 span의 유일한 자식
  // (AIcon)을 건드리지 않고 muted 텍스트를 하나 더 끼워 넣는다 — 원래 있던 AIcon 아이콘은
  // 그대로 두고 "실수로 muted 텍스트를 추가했다"를 재현.
  describe('축 (a) 객체 맵 — doc-gate-section.tsx (AUDIT_META)', () => {
    const REL_FILE = 'components/docs/doc-gate-section.tsx';
    const ABS_FILE = path.join(SRC_ROOT, REL_FILE);
    const original = readFileSync(ABS_FILE, 'utf8');

    // 전제 확인 — story #3865(AC1 정밀화, PO 조건①②) 뒤로는 438행이 더 이상 위반이 아니다.
    // am.dot 바인딩이 AUDIT_META 4개 항목의 class 후보를 하나의 그룹으로 모으는데, 그 그룹의
    // 어느 «한» 후보 문자열도 tint+muted를 동시에 담지 않는다(resubmit 항목은 순수
    // bg-muted+text-muted-foreground, 나머지 3항목은 순수 tint) — 같은 그룹=상호배타라
    // 실제 공존 0(sameElementCoOccurs, story #3865). 남은 위반은 408행(기존 #3839
    // GRANDFATHER_BASELINE 등재분)뿐이다.
    it('전제: 원본은 408행(destructive)만 위반 — 438행은 #3865 정밀화로 더 이상 위반 아님', () => {
      const violations = scanContent(original, REL_FILE, componentMap);
      expect(violations).toHaveLength(1);
      expect(violations.find((v) => v.line === 438)).toBeUndefined();
      expect(violations.find((v) => v.line === 408)?.family).toBe('destructive');
    });

    it('AIcon 옆에 muted 텍스트를 끼워 넣으면(객체 맵으로 조회된 tint가 조상으로 인식돼) 위반이 +1 된다', () => {
      const target = '<AIcon className="size-2.5" />';
      expect(original.includes(target)).toBe(true);
      const mutated = original.replace(target, `${target}<b className="text-muted-foreground">x</b>`);
      expect(mutated).not.toBe(original);

      const before = scanContent(original, REL_FILE, componentMap);
      const after = scanContent(mutated, REL_FILE, componentMap);
      expect(after.length).toBe(before.length + 1);
      const newViolation = after.find((v) => !before.some((b) => b.line === v.line && b.family === v.family));
      expect(newViolation).toBeDefined();
      // AUDIT_META 선언 순(request가 첫 항목, bg-info-tint) — 첫 매치 family가 채택된다.
      expect(newViolation!.family).toBe('info');
    });
  });

  // 축 (b) 삼항/템플릿 리터럴 — doc-status-rail.tsx의 최상위 div가 템플릿 치환 «안» 중첩
  // 삼항(confirmed→success/denied→destructive/그 외→warning)으로 tint 배경을 고른다(161-163행).
  // 그 div의 직계 자식(172행 상태 라벨) 바로 뒤에 muted 텍스트를 하나 더 끼워 넣는다.
  describe('축 (b) 템플릿 리터럴 안 삼항 — doc-status-rail.tsx', () => {
    const REL_FILE = 'components/docs/doc-status-rail.tsx';
    const ABS_FILE = path.join(SRC_ROOT, REL_FILE);
    const original = readFileSync(ABS_FILE, 'utf8');

    it('상태 라벨 옆에 muted 텍스트를 끼워 넣으면(템플릿 치환 안 삼항 tint가 조상으로 인식돼) RED', () => {
      const target = '<div className="text-[15px] font-bold text-foreground">{t(STATE_LABEL_KEY[state])}</div>';
      expect(original.includes(target)).toBe(true);
      const mutated = original.replace(target, `${target}<div className="text-muted-foreground">x</div>`);
      expect(mutated).not.toBe(original);

      const before = scanContent(original, REL_FILE, componentMap);
      const after = scanContent(mutated, REL_FILE, componentMap);
      expect(after.length).toBe(before.length + 1);
      const newViolation = after.find((v) => !before.some((b) => b.line === v.line && b.family === v.family));
      expect(newViolation).toBeDefined();
      // 삼항 첫 분기(state === 'confirmed' → bg-success-tint)가 첫 매치 family로 채택된다.
      expect(newViolation!.family).toBe('success');
    });
  });
});

// story #3865(AC1, PO 조건②③·2026-09-14 11:04Z) — 같은 요소 tint+muted 공존 판정을
// "합친 문자열 전체"에서 "그룹 단위"(같은 삼항/바인딩 안 분기끼리만 상호배타, 서로 다른
// 독립 축은 곱집합·fail-closed)로 정밀화한 것의 양성/음성대조.
describe('scanContent — 같은 요소 tint/muted 공존 판정의 그룹 정밀화(story #3865)', () => {
  // 조건② 양성대조 — 서로 다른(독립) 두 조건이 각각 tint·muted를 낸다면, 그 둘이 동시에
  // 참일 수 있으므로(곱집합) 위반으로 잡아야 한다(fail-closed) — doc-gate-section.tsx류
  // (같은 삼항/바인딩의 두 분기)와 겉보기엔 비슷하지만 독립 조건이라는 점이 다르다.
  it('서로 다른 독립 조건 2개(cn() 인자 2개, 각각 tint·muted) → RED(곱집합 fail-closed)', () => {
    const content = `
      <div className={cn(condA ? 'bg-info-tint' : 'x', condB ? 'text-muted-foreground' : 'y')} />
    `;
    const violations = scanContent(content, 'sample.tsx');
    expect(violations).toHaveLength(1);
    expect(violations[0]!.family).toBe('info');
  });

  // 조건② 음성대조 — 같은 삼항(같은 조건)의 두 분기는 상호배타이므로 위반이 아니다
  // (doc-gate-section.tsx 실사례와 동형 — 합성 표본으로 규칙 자체를 직접 확인).
  it('같은 삼항의 두 분기(하나는 tint, 하나는 muted) → 위반 아님(같은 조건=상호배타)', () => {
    const content = `
      <div className={cond ? 'bg-info-tint text-info' : 'bg-muted text-muted-foreground'} />
    `;
    expect(scanContent(content, 'sample.tsx')).toEqual([]);
  });

  // 조건③ 실 파일 양성대조 — access-matrix-tab.tsx(232행)의 `granted ? 'border-success/40
  // bg-success-tint text-success…' : 'border-border text-muted-foreground…'`(같은 삼항의
  // 두 분기)를 "한 분기 안에 tint+muted 공존"으로 되돌리면(granted 분기 자체에 muted를
  // 끼워 넣으면) RED가 되어야 한다 — 그룹 정밀화가 진짜 공존은 여전히 잡는다는 확인.
  describe('실 파일 뮤테이션 — access-matrix-tab.tsx(232행, 같은 삼항 안 공존 재현)', () => {
    const REL_FILE = 'components/agents/access-matrix-tab.tsx';
    const ABS_FILE = path.join(SRC_ROOT, REL_FILE);
    const original = readFileSync(ABS_FILE, 'utf8');

    it('전제: 원본은 이 자리에서 위반 0(같은 삼항 두 분기가 상호배타)', () => {
      const violations = scanContent(original, REL_FILE);
      expect(violations.some((v) => v.className.includes('bg-success-tint'))).toBe(false);
    });

    it('granted 분기(tint) 안에 muted를 끼워 넣으면(같은 후보 문자열 공존) RED', () => {
      const target = "'border-success/40 bg-success-tint text-success hover:bg-success/15'";
      expect(original.includes(target)).toBe(true);
      const mutated = original.replace(
        target,
        "'border-success/40 bg-success-tint text-success hover:bg-success/15 text-muted-foreground'",
      );
      expect(mutated).not.toBe(original);

      const before = scanContent(original, REL_FILE);
      const after = scanContent(mutated, REL_FILE);
      expect(after.length).toBe(before.length + 1);
      const newViolation = after.find((v) => !before.some((b) => b.line === v.line));
      expect(newViolation).toBeDefined();
      expect(newViolation!.family).toBe('success');
    });
  });
});

// story #3865(AC1, PO CHANGES 2026-09-14 11:40Z «같은 조건식=같은 세계») — 조상의 tint
// 조건식과 자손의 muted 조건식이 완전히 같은 소스 텍스트면(예: 둘 다 `wipExceeded`), 그
// 두 분기가 실제로 엇갈리는지(tint 뜨는 분기 ≠ muted 뜨는 분기)까지 확인한다. kanban-
// column.tsx PR 리뷰에서 평시(wipExceeded=false) 컬럼까지 ink로 무거워진 회귀(캡처 「개발
// 대기 0」 증거)가 이 규칙 부재로 생겼다 — 자식 클래스를 조건부(`wipExceeded ? ink : muted`)로
// 고친 뒤에도 가드가 계속 "조상 destructive-tint 위 muted 있음"으로 오탐하면 원복 압력이
// 생기므로, 이 규칙 없이는 처방①(조건부 ink)이 가드와 충돌한다.
describe('scanContent — 조상-자손 간 같은 조건식 정밀화(story #3865, PO CHANGES 조건②)', () => {
  // 조건② 음성대조 — 조상 tint를 켜는 조건(`flag`)과 자손 muted를 켜는 조건이 완전히
  // 같은 소스 텍스트이고 분기가 엇갈리면(조상=true일 때 tint, 자손=true일 때 ink·false일
  // 때만 muted) 실제 공존이 0이라 위반이 아니다 — kanban-column.tsx colClass/자식 className
  // 패턴과 동형.
  it('조상·자손이 같은 조건식을 쓰고 분기가 엇갈리면(tint↔ink 동시) 위반 아님', () => {
    const content = `
      function Col({ flag }) {
        const colClass = flag ? 'bg-destructive-tint' : 'bg-transparent';
        return (
          <div className={\`wrapper \${colClass}\`}>
            <span className={flag ? 'text-foreground' : 'text-muted-foreground'}>count</span>
          </div>
        );
      }
    `;
    expect(scanContent(content, 'sample.tsx')).toEqual([]);
  });

  // 조건② 양성대조(PO 명시 요청 — "자식 조건식을 다른 변수로 바꾸면 RED") — 조상은
  // `flag`로 tint를 켜는데 자손은 **다른** 독립 변수(`otherFlag`)로 muted를 켜면, 두 조건이
  // 독립이라 동시에 참일 수 있다(곱집합) — 기존 보수적 판정(어디든 muted 있으면 위반)으로
  // 폴백해야 한다(fail-closed 유지).
  it('조상·자손이 서로 다른(독립) 조건식을 쓰면 여전히 위반(곱집합 fail-closed)', () => {
    const content = `
      function Col({ flag, otherFlag }) {
        const colClass = flag ? 'bg-destructive-tint' : 'bg-transparent';
        return (
          <div className={\`wrapper \${colClass}\`}>
            <span className={otherFlag ? 'text-foreground' : 'text-muted-foreground'}>count</span>
          </div>
        );
      }
    `;
    const violations = scanContent(content, 'sample.tsx');
    expect(violations).toHaveLength(1);
    expect(violations[0]!.family).toBe('destructive');
  });

  // 실 파일 — kanban-column.tsx: colClass(wipExceeded)와 11곳 자식 className(wipExceeded
  // 삼항)이 실제로 이 규칙 덕에 GREEN인지, 그리고 자식 조건식을 다른 변수로 바꾸면(PO 명시
  // 양성대조) RED로 돌아오는지 확인한다.
  describe('실 파일 뮤테이션 — kanban-column.tsx(같은 조건식 wipExceeded)', () => {
    const REL_FILE = 'components/kanban/kanban-column.tsx';
    const ABS_FILE = path.join(SRC_ROOT, REL_FILE);
    const original = readFileSync(ABS_FILE, 'utf8');

    it('전제: 원본은 이 파일에서 위반 0(colClass·자식 className 모두 wipExceeded, 분기가 엇갈림)', () => {
      expect(scanContent(original, REL_FILE)).toEqual([]);
    });

    it('빈 상태 문구의 조건식을 다른(독립) 변수로 바꾸면 RED로 돌아온다', () => {
      const target = "<p className={`text-xs ${wipExceeded ? 'text-foreground' : 'text-muted-foreground'}`}>{t('noStories')}</p>";
      expect(original.includes(target)).toBe(true);
      const mutated = original.replace(
        target,
        "<p className={`text-xs ${collapsed ? 'text-foreground' : 'text-muted-foreground'}`}>{t('noStories')}</p>",
      );
      expect(mutated).not.toBe(original);

      const after = scanContent(mutated, REL_FILE);
      expect(after.length).toBeGreaterThan(0);
      expect(after.some((v) => v.family === 'destructive')).toBe(true);
    });
  });
});

// story #3865(AC1, 조건①·2026-09-14 11:04Z) — 불투명 배경 규칙(OPAQUE_BG_RE)이 recruiter-
// client.tsx의 기존 #3839 grandfather 1건(muted-on-info-tint)도 실제로 걷어냈다(3865 스코프
// 밖 파일이지만 baseline 정확 일치 계약상 이 PR에 같이 실린다) — 실 파일 양성대조.
describe('scanContent — 실 파일 양성대조(recruiter-client.tsx, 불투명 배경 규칙)', () => {
  const REL_FILE = 'app/(authenticated)/organization/workforce/recruiter/recruiter-client.tsx';
  const ABS_FILE = path.join(SRC_ROOT, REL_FILE);
  const original = readFileSync(ABS_FILE, 'utf8');

  // 1110행 input — info-tint 조상(신규 에이전트 생성 섹션) 서브트리 안에 있지만 자기 자신이
  // bg-card(완전 불투명)를 입고 있어 그 조상 tint가 안 비쳐 보인다 — input 자신의
  // placeholder:text-muted-foreground는 실제로 불투명 카드 배경 위에서만 렌더된다.
  it('전제: 원본은 이 input 자리에서 위반 0(bg-card가 조상 info-tint를 끊음)', () => {
    const violations = scanContent(original, REL_FILE);
    expect(violations.some((v) => v.className.includes('placeholder:text-muted-foreground'))).toBe(false);
  });

  it('bg-card를 걷으면(불투명 경계 소실) 조상 info-tint가 다시 비쳐 RED', () => {
    // value={newAgentName}로 시작하는 입력은 파일에 하나뿐(1112행) — 그 className까지
    // 통째로 타깃 삼아 결정적으로 그 입력 하나만 고른다(다른 bg-card 입력과 안 섞임).
    const target = "value={newAgentName}\n                      onChange={(e) => setNewAgentName(e.target.value)}\n                      placeholder={suggestedAgentName || t('agentNamePlaceholder')}\n                      className=\"w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary\"";
    expect(original.includes(target)).toBe(true);
    const mutated = original.replace(target, target.replace('bg-card ', ''));
    expect(mutated).not.toBe(original);

    const before = scanContent(original, REL_FILE);
    const after = scanContent(mutated, REL_FILE);
    expect(after.length).toBeGreaterThan(before.length);
    const newViolation = after.find((v) => !before.some((b) => b.line === v.line));
    expect(newViolation).toBeDefined();
    expect(newViolation!.family).toBe('info');
  });
});
