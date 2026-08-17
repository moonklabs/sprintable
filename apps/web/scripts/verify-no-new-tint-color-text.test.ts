import { describe, expect, it } from 'vitest';
import {
  findTintTextPairs,
  scanContent,
  violationKey,
  loadBaseline,
  assertParseDiagnosticsReadable,
} from './verify-no-new-tint-color-text';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('findTintTextPairs (story #2420 AC7)', () => {
  it('flags bg-<X>/N + text-<X> in the same literal', () => {
    expect(findTintTextPairs('rounded-md bg-destructive/10 text-destructive')).toEqual([
      { family: 'destructive', literal: 'rounded-md bg-destructive/10 text-destructive' },
    ]);
  });

  it('flags bg-<X>-tint + text-<X> in the same literal', () => {
    const hits = findTintTextPairs('border border-warning-border bg-warning-tint text-warning');
    expect(hits.map((h) => h.family)).toEqual(['warning']);
  });

  // story #2575 AC2 — #2960(HITL 카드) 헤더 라벨이 정확히 이 모양이었다: bg-warning-bg +
  // text-warning, 같은 className 리터럴. -tint 확장 전엔 이 자리를 안 잡았다(근본원인).
  it('flags bg-<X>-bg + text-<X> in the same literal (story #2575 AC2 — #2960 근본원인 재현)', () => {
    const hits = findTintTextPairs('mb-1.5 flex items-center gap-1.5 rounded-xl bg-warning-bg text-warning');
    expect(hits.map((h) => h.family)).toEqual(['warning']);
  });

  it('does not flag solid bg-<X>-bg without matching text-<X> in the same literal', () => {
    expect(findTintTextPairs('rounded-xl border border-warning-border bg-warning-bg px-3.5 py-3')).toEqual([]);
  });

  it('does not flag a fixed site (text-foreground on tint bg)', () => {
    expect(findTintTextPairs('bg-destructive/10 text-foreground')).toEqual([]);
  });

  it('does not flag solid bg-<X> without tint/alpha suffix (dark button bg, out of scope)', () => {
    expect(findTintTextPairs('bg-destructive text-destructive-foreground')).toEqual([]);
  });

  it('does not flag text-<X>-foreground as text-<X> (word boundary)', () => {
    expect(findTintTextPairs('bg-destructive/10 text-destructive-foreground')).toEqual([]);
  });

  it('does not flag family present only as bg with no matching text', () => {
    expect(findTintTextPairs('bg-info/10 text-muted-foreground')).toEqual([]);
  });

  it('flags each family independently when multiple pairs coexist in one literal', () => {
    const hits = findTintTextPairs('bg-success/10 text-success bg-info-tint text-info');
    expect(hits.map((h) => h.family).sort()).toEqual(['info', 'success']);
  });
});

describe('scanContent (line numbers + literal extraction)', () => {
  it('reports the correct line number for a match past the first line', () => {
    const content = [
      "const a = 'unrelated';",
      "const b = 'still unrelated';",
      "const c = 'bg-destructive/10 text-destructive';",
    ].join('\n');
    const violations = scanContent(content, 'fake.tsx');
    expect(violations).toHaveLength(1);
    expect(violations[0]!.line).toBe(3);
    expect(violations[0]!.family).toBe('destructive');
  });

  it('matches inside a template literal with an interpolated ternary', () => {
    const content = 'const x = `text-xs ${cond ? "border bg-warning-tint text-warning" : "text-muted-foreground"}`;';
    const violations = scanContent(content, 'fake.tsx');
    expect(violations.some((v) => v.family === 'warning')).toBe(true);
  });

  it('produces a stable key independent of surrounding file content (query_sentinel-style key)', () => {
    const v = { file: 'a.tsx', family: 'success' as const, literal: 'bg-success/10 text-success' };
    expect(violationKey(v)).toBe('a.tsx::success::bg-success/10 text-success');
  });
});

describe('known documented limitation — split-literal cn() calls are NOT paired', () => {
  it('does not flag when bg and text live in separate string arguments to cn()', () => {
    const content = "cn('bg-destructive/10', isActive && 'text-destructive')";
    const violations = scanContent(content, 'fake.tsx');
    expect(violations).toHaveLength(0);
  });
});

describe('quote-pairing swallow bug — story #2710 AC1/AC2 (root cause: PR #3165 CI 빨강 추적)', () => {
  // AC1 — 옛 정규식(LITERAL_RE quote-pairing)은 주석 속 짝 없는 apostrophe 하나 뒤로 실제
  // 위반의 여는/닫는 따옴표 자체를 소비해버려, 그 위반이 "리터럴"로 추출조차 안 됐다(미탐).
  it('detects a real violation whose literal comes after an unpaired apostrophe in an earlier comment', () => {
    const content = ["// don't do this", "const x = 'bg-warning-tint text-warning';"].join('\n');
    const violations = scanContent(content, 'fake.tsx');
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ family: 'warning', literal: 'bg-warning-tint text-warning' });
  });

  // AC2 — PR #3165의 정확한 재현(주석 `ⓐ'로`류 apostrophe) 회귀 케이스: 위반이 실제로
  // 잡히되(미탐 0), 스왈로우로 인한 무관 코드 뭉치 오탐도 0이어야 한다.
  it("reproduces PR #3165 exactly (the ⓐ' apostrophe) — catches the real pair, zero false positives on unrelated surrounding code", () => {
    const content = [
      "// ⓐ'로 처리한다 — 하위 처방",
      'export function unrelated() {',
      "  const other = 'this literal has nothing tint-related in it';",
      '  return other;',
      '}',
      '',
      "const cls = 'bg-info-tint text-info';",
    ].join('\n');
    const violations = scanContent(content, 'fake.tsx');
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ family: 'info', literal: 'bg-info-tint text-info' });
  });

  // AC3 — 뮤테이션: 파서를 옛 quote-pairing 정규식으로 되돌리면(가짜 재현) 위 AC1 케이스가
  // 다시 미탐으로 떨어짐을 직접 확認 — 이 fix가 실제로 그 버그를 없앴다는 증거.
  it('mutation-kill: the old quote-pairing regex misses the exact AC1 case (proves the parser swap is load-bearing)', () => {
    const OLD_LITERAL_RE = /'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)"|`([^`\\]*(?:\\.[^`\\]*)*)`/g;
    function oldScan(content: string): string[] {
      const literals: string[] = [];
      for (const m of content.matchAll(OLD_LITERAL_RE)) {
        const literal = m[1] ?? m[2] ?? m[3] ?? '';
        if (literal) literals.push(literal);
      }
      return literals;
    }
    const content = ["// don't do this", "const x = 'bg-warning-tint text-warning';"].join('\n');
    const literals = oldScan(content);
    expect(literals.some((l) => l.includes('bg-warning-tint') && l.includes('text-warning'))).toBe(false);
  });
});

describe('AC4 — self-check: unparseable file goes RED, not a silent skip (story #2710)', () => {
  it('throws when the file fails to parse instead of silently returning no violations', () => {
    const unterminated = "const x = 'bg-warning-tint text-warning";
    expect(() => scanContent(unterminated, 'broken.tsx')).toThrow(/파싱 실패/);
  });

  // 미르코 QA(2026-08-17) — parseDiagnostics가 undefined면(TS 내부 API가 향후 이 필드
  // 자체를 없애는 경우) length 체크만으로는 falsy라 조용히 통과해버리는 fallback 취약점.
  // scanContent에서 분리한 순수 함수를 직접 호출해 undefined 분기를 테스트한다(ts.createSourceFile
  // 자체는 모킹 불가 — export가 configurable하지 않다, 그래서 로직을 분리해 이 축을 검증한다).
  it('throws when parseDiagnostics itself is undefined (TS internal API drift), not a silent pass', () => {
    expect(() => assertParseDiagnosticsReadable('drifted.tsx', undefined)).toThrow(
      /parseDiagnostics 필드가 사라짐/,
    );
  });

  it('does not throw for a clean parse (empty diagnostics array)', () => {
    expect(() => assertParseDiagnosticsReadable('clean.tsx', [])).not.toThrow();
  });
});

describe('loadBaseline — JSON storage (regression: newline-in-literal corruption)', () => {
  it('round-trips a key whose literal contains a real newline without splitting it', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tint-baseline-test-'));
    const file = path.join(dir, 'baseline.json');
    const multilineKey = 'fake.tsx::warning::border bg-warning-tint text-warning\n  more-on-next-line';
    writeFileSync(file, JSON.stringify({ _comment: [], keys: [multilineKey] }));
    const loaded = loadBaseline(file);
    expect(loaded.size).toBe(1);
    expect(loaded.has(multilineKey)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns an empty set when the file does not exist (fresh repo, no baseline yet)', () => {
    expect(loadBaseline('/nonexistent/path/baseline.json').size).toBe(0);
  });
});
