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

function hit(className: string) {
  let result: ReturnType<typeof findHardcodedShellChromeAnchors> = [];
  withTempSrc(
    { 'app/page.tsx': `export default function X() { return <div className="${className}">x</div>; }\n` },
    (r) => { result = findHardcodedShellChromeAnchors(r); },
  );
  return result;
}

describe('findHardcodedShellChromeAnchors (story #4131 — 하드코딩 뷰포트 앵커 재유입 가드)', () => {
  it('⭐flags a hardcoded h-[calc(100svh-3rem)] className (양성대조 — #4130 실사고 재현)', () => {
    withTempSrc(
      { 'app/page.tsx': `export default function X() { return <div className="h-[calc(100svh-3rem)]">x</div>; }\n` },
      (root) => {
        const hits = findHardcodedShellChromeAnchors(root);
        expect(hits).toEqual([{ file: 'app/page.tsx', line: 1, found: 'calc(100svh-3rem)' }]);
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

  // story #4131 CHANGES-1(페드루 PO 지적, 2026-09-22 01:24Z) — 원래 정규식이 정확히
  // `calc(100svh-3rem)` 글자꼴 하나만 잡아 아래 4가지 변형이 전부 새 통로였다. "calc 안에서
  // 100(s|d|l)?vh에서 뭔가를 직접 빼는 표현 전부"로 넓힌 뒤 각각 RED가 되는지 pin한다.
  describe('CHANGES-1 — 변형 4종 전부 RED(양성대조)', () => {
    it('⭐100dvh 변형(vh 접두 다름)', () => {
      const hits = hit('h-[calc(100dvh-3rem)]');
      expect(hits.length).toBe(1);
      expect(hits[0]!.found).toBe('calc(100dvh-3rem)');
    });

    it('⭐100lvh 변형', () => {
      const hits = hit('h-[calc(100lvh-3rem)]');
      expect(hits.length).toBe(1);
    });

    it('⭐접두어 없는 100vh 변형', () => {
      const hits = hit('h-[calc(100vh-3rem)]');
      expect(hits.length).toBe(1);
    });

    it('⭐px 하드코딩(탭바 높이를 rem 대신 px로)', () => {
      const hits = hit('h-[calc(100svh-48px)]');
      expect(hits.length).toBe(1);
      expect(hits[0]!.found).toBe('calc(100svh-48px)');
    });

    it('⭐잘못된 변수 직접 참조(SSOT 변수 --shell-chrome-h가 아니라 --mobile-tab-bar-h를 직접 뺌)', () => {
      const hits = hit('h-[calc(100svh-var(--mobile-tab-bar-h))]');
      expect(hits.length).toBe(1);
      expect(hits[0]!.found).toBe('calc(100svh-var(--mobile-tab-bar-h))');
    });

    it('⭐다항 조합(SSOT 변수를 쓰지만 추가로 더 뺌 — 부분 일치도 불허)', () => {
      const hits = hit('h-[calc(100svh-var(--shell-chrome-h)-8px)]');
      expect(hits.length).toBe(1);
    });

    it('var(--shell-chrome-h) 안의 내부 괄호 때문에 조기 종료되지 않는다(depth-tracking 확認 — 정확한 허용 표현은 여전히 통과)', () => {
      // 위 "does NOT flag" 테스트와 같은 취지지만, 여러 변형과 나란히 이 depth-tracking
      // 정확성을 명시적으로 pin해 둔다(정규식이 `var(--shell-chrome-h)`의 첫 `)`에서 조기
      // 종료돼 오탐하는 회귀를 방지).
      expect(hit('h-[calc(100svh-var(--shell-chrome-h))]')).toEqual([]);
    });
  });

  it('실 소스 전수 스캔 — 0건(#4131 AC2 반영 확認)', () => {
    const srcRoot = path.resolve(__dirname, '../src');
    expect(findHardcodedShellChromeAnchors(srcRoot)).toEqual([]);
  });
});
