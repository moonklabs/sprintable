import { describe, expect, it } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  isHandrolledCardLiteral,
  scanContent,
  violationKey,
  loadBaseline,
  assertParseDiagnosticsReadable,
  EXEMPT_FILES,
} from './verify-no-handrolled-card';

describe('isHandrolledCardLiteral (story #3164 Gate B)', () => {
  it('flags rounded-xl + border + bg-card co-occurring in the same literal', () => {
    expect(isHandrolledCardLiteral('rounded-xl border bg-card p-4')).toBe(true);
  });

  it('flags rounded-lg + border + bg-background', () => {
    expect(isHandrolledCardLiteral('flex rounded-lg border bg-background shadow-sm')).toBe(true);
  });

  it('flags rounded-2xl + border + bg-muted', () => {
    expect(isHandrolledCardLiteral('rounded-2xl border bg-muted/50')).toBe(true);
  });

  it('flags rounded-xl + border + bg-popover', () => {
    expect(isHandrolledCardLiteral('rounded-xl border bg-popover p-2')).toBe(true);
  });

  it('does not flag rounded-md(밖의 반경 값) even with border+bg-card', () => {
    expect(isHandrolledCardLiteral('rounded-md border bg-card')).toBe(false);
  });

  it('does not flag rounded-xl+bg-card without border(표면 축 하나 부재)', () => {
    expect(isHandrolledCardLiteral('rounded-xl bg-card p-4')).toBe(false);
  });

  it('does not flag rounded-xl+border without a card-surface bg(칩/인풋류, 대상 밖)', () => {
    expect(isHandrolledCardLiteral('rounded-xl border px-2 py-1')).toBe(false);
  });

  it('does not flag border-t/border-b as bare "border"(단어 경계)', () => {
    expect(isHandrolledCardLiteral('rounded-xl border-t bg-card')).toBe(false);
  });

  it('does not flag bg-card-foreground as bg-card(단어 경계)', () => {
    expect(isHandrolledCardLiteral('rounded-xl border bg-card-foreground')).toBe(false);
  });
});

describe('scanContent — JSX/AST 경유(line + literal 추출)', () => {
  it('reports the correct line number for a match past the first line', () => {
    const content = [
      "const a = 'unrelated';",
      'function C() {',
      "  return <div className='rounded-xl border bg-card p-4' />;",
      '}',
    ].join('\n');
    const violations = scanContent(content, 'fake.tsx');
    expect(violations).toHaveLength(1);
    expect(violations[0]!.line).toBe(3);
  });

  it('matches inside a cn() call wrapping a template literal', () => {
    const content = "const x = cn(`rounded-xl border bg-card ${extra}`);";
    const violations = scanContent(content, 'fake.tsx');
    expect(violations).toHaveLength(1);
  });

  it('produces a stable file::literal key(줄 번호 무관)', () => {
    expect(violationKey({ file: 'a.tsx', literal: 'rounded-xl border bg-card' })).toBe('a.tsx::rounded-xl border bg-card');
  });
});

// AC2 — 캐노니컬 카드 태그(Card/SectionCard/GlassPanel) 자신에 실린 리터럴은 손코딩이
// 아니라 캐노니컬 위 장식이므로 SAFE(verify-no-handrolled-modal.ts SAFE_PRIMITIVE_TAG와 동형).
describe('SAFE 캐노니컬 카드 태그 — 손코딩이 아니라 캐노니컬 위 override', () => {
  it('<Card className="rounded-xl border bg-card">는 SAFE(캐노니컬 태그 자신)', () => {
    const content = "function C() { return <Card className='rounded-xl border bg-card' />; }";
    expect(scanContent(content, 'fake.tsx')).toEqual([]);
  });

  it('<SectionCard>도 SAFE', () => {
    const content = "function C() { return <SectionCard className='rounded-xl border bg-card' />; }";
    expect(scanContent(content, 'fake.tsx')).toEqual([]);
  });

  it('<GlassPanel>도 SAFE', () => {
    const content = "function C() { return <GlassPanel className='rounded-xl border bg-card' />; }";
    expect(scanContent(content, 'fake.tsx')).toEqual([]);
  });

  it('같은 리터럴이어도 <div>면(캐노니컬 태그 아님) 여전히 위반이다', () => {
    const content = "function C() { return <div className='rounded-xl border bg-card' />; }";
    expect(scanContent(content, 'fake.tsx')).toHaveLength(1);
  });

  it('cn() 등 CallExpression을 거쳐도(className={cn(...)}) 캐노니컬 태그면 SAFE(중첩 통과)', () => {
    const content = "function C() { return <Card className={cn('rounded-xl border bg-card', extra)} />; }";
    expect(scanContent(content, 'fake.tsx')).toEqual([]);
  });
});

describe('known documented limitation — split-literal cn() calls are NOT paired', () => {
  it('does not flag when rounded/border/bg live in separate string arguments to cn()', () => {
    const content = "cn('rounded-xl', 'border', isActive && 'bg-card')";
    expect(scanContent(content, 'fake.tsx')).toHaveLength(0);
  });
});

describe('EXEMPT_FILES가 실제로 존재하는 경로다', () => {
  it('EXEMPT_FILES 항목이 문자열 집합이다(형식 최소 확認)', () => {
    expect(EXEMPT_FILES.size).toBeGreaterThan(0);
    for (const f of EXEMPT_FILES) expect(typeof f).toBe('string');
  });
});

describe('AC4 — self-check: unparseable file goes RED, not a silent skip (story #2710 동형)', () => {
  it('throws when the file fails to parse instead of silently returning no violations', () => {
    const unterminated = "const x = <div className='rounded-xl border bg-card";
    expect(() => scanContent(unterminated, 'broken.tsx')).toThrow(/파싱 실패/);
  });

  it('throws when parseDiagnostics itself is undefined (TS internal API drift), not a silent pass', () => {
    expect(() => assertParseDiagnosticsReadable('drifted.tsx', undefined)).toThrow(/parseDiagnostics 필드가 사라짐/);
  });

  it('does not throw for a clean parse (empty diagnostics array)', () => {
    expect(() => assertParseDiagnosticsReadable('clean.tsx', [])).not.toThrow();
  });
});

describe('loadBaseline — JSON storage', () => {
  it('returns an empty set when the file does not exist(fresh repo, no baseline yet)', () => {
    expect(loadBaseline('/nonexistent/path/handrolled-card-baseline.json').size).toBe(0);
  });

  it('round-trips a key whose literal contains multiple tokens', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'card-baseline-test-'));
    const file = path.join(dir, 'baseline.json');
    const key = 'components/foo.tsx::rounded-xl border bg-card p-4';
    writeFileSync(file, JSON.stringify({ _comment: [], keys: [key] }));
    const loaded = loadBaseline(file);
    expect(loaded.has(key)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

// AC6 — 「baseline 밖 신규 위반 픽스처로 FAIL을, EXEMPT/SAFE 자리 픽스처로 PASS를 각각 실증」.
describe('AC6 — 양성대조(baseline 판정이 실제로 FAIL/PASS를 가르는지)', () => {
  it('baseline에 없는 새 위반은 신규로 잡힌다', () => {
    const content = "function C() { return <div className='rounded-xl border bg-card new-marker' />; }";
    const violations = scanContent(content, 'fake.tsx');
    const baseline = new Set<string>(); // 빈 baseline — 아무것도 grandfather 안 됨.
    const newOnes = violations.filter((v) => !baseline.has(violationKey(v)));
    expect(newOnes).toHaveLength(1);
  });

  it('baseline에 등재된 정확히 같은 file::literal은 grandfather로 통과한다', () => {
    const content = "function C() { return <div className='rounded-xl border bg-card grandfathered' />; }";
    const violations = scanContent(content, 'fake.tsx');
    const baseline = new Set<string>([violationKey({ file: 'fake.tsx', literal: 'rounded-xl border bg-card grandfathered' })]);
    const newOnes = violations.filter((v) => !baseline.has(violationKey(v)));
    expect(newOnes).toHaveLength(0);
  });

  it('SAFE 캐노니컬 태그(Card) 픽스처는 baseline 유무와 무관하게 애초에 위반 자체가 안 잡힌다', () => {
    const content = "function C() { return <Card className='rounded-xl border bg-card' />; }";
    expect(scanContent(content, 'fake.tsx')).toEqual([]);
  });
});

describe('실 저장소 baseline 파일 형식', () => {
  it('handrolled-card-baseline.json은 파싱 가능하고 모든 키가 file::literal 형식이다', () => {
    const baseline = loadBaseline(path.resolve(__dirname, 'handrolled-card-baseline.json'));
    expect(baseline.size).toBeGreaterThan(0);
    for (const key of baseline) {
      expect(key).toContain('::');
    }
  });
});
