// story 4831 — `var(--color-…)`는 쓰지 않는다. globals.css의 `@theme inline`은 `--color-*`를 CSS 변수로 «내보내지 않는다»(유틸리티 안에 값을 직접 넣을 뿐: `.border-border { border-color: var(--border) }`).
// 그래서 소스에서 `var(--color-border)`를 쓰면 런타임에 빈 값이다 — SVG 속성이나 인라인 style이 조용히 기본값(검정 · 없음)으로 떨어진다. 대체값(`var(--color-x, #hex)`)이 붙어 있으면 늘 그 hex만 쓰였다.
// 쓸 변수는 실제로 정의된 이름이다: `var(--border)` · `var(--brand)` · `var(--success-tint)` 등(`:root`와 `.dark`에 있다). 실측: 실제 globals.css를 Tailwind v4로 컴파일하면 `--color-border`는 출력에 없고 `--border`는 있다.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '../src');
const TEST_RE = /\.(test|spec|guard)\.(ts|tsx)$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !TEST_RE.test(e.name)) out.push(full);
  }
  return out;
}

describe('방출되지 않는 테마 변수(--color-*)를 소스가 쓰지 않는다', () => {
  it('비-시험 소스에 var(--color-…)가 0건이다', () => {
    const hits: string[] = [];
    for (const f of walk(SRC)) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (/var\(--color-[a-z0-9-]+/.test(line)) hits.push(`${path.relative(SRC, f)}:${i + 1}`);
      });
    }
    expect(hits, '@theme inline은 --color-*를 내보내지 않는다 — 실제 변수 이름(var(--border) 등)을 쓴다').toEqual([]);
  });

  it('양성 대조: 이 탐지식은 var(--color-border) 한 줄을 실제로 잡는다', () => {
    expect(/var\(--color-[a-z0-9-]+/.test('<line stroke="var(--color-border)" />')).toBe(true);
    expect(/var\(--color-[a-z0-9-]+/.test('<line stroke="var(--border)" />')).toBe(false);
  });
});
