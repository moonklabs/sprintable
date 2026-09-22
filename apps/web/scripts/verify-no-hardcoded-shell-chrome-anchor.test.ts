import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findHardcodedShellChromeAnchors } from './verify-no-hardcoded-shell-chrome-anchor';

function withTempSrc(files: Record<string, string>, fn: (root: string) => void) {
  const root = mkdtempSync(path.join(tmpdir(), 'shell-chrome-anchor-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(root, rel);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('findHardcodedShellChromeAnchors (story #4131 — 하드코딩 3rem 재유입 가드)', () => {
  it('⭐flags a hardcoded h-[calc(100svh-3rem)] className (양성대조 — #4130 실사고 재현)', () => {
    withTempSrc(
      { 'app/page.tsx': `export default function X() { return <div className="h-[calc(100svh-3rem)]">x</div>; }\n` },
      (root) => {
        const hits = findHardcodedShellChromeAnchors(root);
        expect(hits).toEqual([{ file: 'app/page.tsx', line: 1 }]);
      },
    );
  });

  it('does NOT flag the correct var(--shell-chrome-h) form', () => {
    withTempSrc(
      { 'app/page.tsx': `export default function X() { return <div className="h-[calc(100svh-var(--shell-chrome-h))]">x</div>; }\n` },
      (root) => {
        expect(findHardcodedShellChromeAnchors(root)).toEqual([]);
      },
    );
  });

  it('does NOT scan globals.css (역사적 맥락 주석 제외)', () => {
    withTempSrc(
      { 'app/globals.css': `/* calc(100svh-3rem) 역사적 설명 */\n` },
      (root) => {
        expect(findHardcodedShellChromeAnchors(root)).toEqual([]);
      },
    );
  });

  it('실 소스 전수 스캔 — 0건(#4131 AC2 반영 확認)', () => {
    const srcRoot = path.resolve(__dirname, '../src');
    expect(findHardcodedShellChromeAnchors(srcRoot)).toEqual([]);
  });
});
