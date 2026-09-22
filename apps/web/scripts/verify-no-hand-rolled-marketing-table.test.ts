// story #4014 AC1 — hasHandRolledTable 순수 함수 pin + 실 3파일 스캔.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hasHandRolledTable, TARGET_FILES } from './verify-no-hand-rolled-marketing-table';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('hasHandRolledTable', () => {
  it('<table 리터럴이 있으면 true — 지우면(판정 로직 삭제) 이 케이스가 RED', () => {
    expect(hasHandRolledTable('return (<table className="w-full text-sm">...</table>);')).toBe(true);
  });

  it('ResponsiveDataTable만 쓰면 false', () => {
    expect(hasHandRolledTable('return (<ResponsiveDataTable columns={columns} rows={rows} />);')).toBe(false);
  });
});

describe('story #4014 AC1 — 대상 3파일 실 스캔', () => {
  it('⭐블로그 포스트·채널 포스트·성과 보드 3파일 모두 <table> 직접 조립 0건', () => {
    for (const rel of TARGET_FILES) {
      const content = readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
      expect(hasHandRolledTable(content), `${rel}가 <table>을 직접 조립함`).toBe(false);
    }
  });
});
