import { describe, expect, it } from 'vitest';
import { findTintTextPairs, scanContent, violationKey, loadBaseline } from './verify-no-new-tint-color-text';
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
