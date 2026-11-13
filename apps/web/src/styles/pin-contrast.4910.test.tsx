// 4910 — 번호 핀 · 스펙 핀은 «그림 위»에 선다: 그림 색은 알 수 없으므로(흰 · 검은 · 가운데 톤 어느 것이든) 핀이 어느 그림 위에서도 보여야 한다.
// 화면이 아니라 부품이 실제로 쓰는 ds 토큰(렌더한 클래스에서 읽음)을 라이트 · 다크의 실제 값(design-system.css)으로 재서 WCAG 대비를 지킨다:
//  - 채움 ↔ 흰 그림 · 검은 그림 ≥ 3:1 (글자 아닌 표시의 선) · 숫자 글 ↔ 채움 ≥ 4.5:1
//  - 채움 둘레 고리(면 색) ↔ 채움 ≥ 3:1, 고리 ↔ 가운데 톤 그림(#808080) ≥ 3:1 — 채움이 가운데 톤 그림에 묻혀도 고리가 갈라 준다
//  - 가라앉은(resolved) 핀: 면 색 채움 위 글 ≥ 4.5:1, 테두리 ↔ 흰 · 검은 그림 ≥ 3:1 · 임시(draft) 핀: 글 ↔ 채움 ≥ 4.5:1, 테두리 ↔ 흰 · 검은 그림 ≥ 3:1
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AnchorPin } from '../components/canvas/anchor-pin';
import { SpecPinMarker } from '../components/canvas/spec-pin-marker';

const css = readFileSync(join(__dirname, 'design-system.css'), 'utf8');
function block(selector: string): Record<string, string> {
  const m = css.match(new RegExp(`(?:^|\\n)${selector.replace('.', '\\.')}(?:,\\s*\\.[\\w-]+)*\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`block ${selector} not found`);
  return Object.fromEntries([...m[1].matchAll(/--ds-([\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)].map((x) => [x[1], x[2].toLowerCase()]));
}
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const relative = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [relative(a), relative(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

const WHITE_ART = '#ffffff';
const BLACK_ART = '#000000';
const MID_ART = '#808080';
const themes: Array<[string, Record<string, string>]> = [['라이트', block(':root')], ['다크', block('.dark')]];

/** 렌더한 핀 첫 요소의 클래스 목록. */
const classesOf = (node: React.ReactElement) => /^<[a-z]+ [^>]*?class="([^"]*)"/.exec(renderToStaticMarkup(node))![1]!.split(' ');
/** 클래스 중 `prefix` + 테마에 실제로 있는 색 토큰 이름. 글자 크기(`text-ds-mono-md`)처럼 색 토큰이 아닌 것은 걸러진다. */
const colorToken = (classes: string[], prefix: string, theme: Record<string, string>) => {
  const names = classes.filter((c) => c.startsWith(prefix)).map((c) => c.slice(prefix.length)).filter((n) => n in theme);
  expect(names, `${prefix}* 색 토큰이 하나여야 함: ${classes.join(' ')}`).toHaveLength(1);
  return names[0]!;
};

describe('번호 핀 — 그림 위 대비 (4910)', () => {
  it.each(themes)('⭐%s: 열린 핀 — 채움 ↔ 흰 · 검은 그림 ≥ 3:1, 숫자 글 ↔ 채움 ≥ 4.5:1, 고리 ↔ 채움 ≥ 3:1, 고리 ↔ 가운데 톤 그림 ≥ 3:1', (_n, t) => {
    const c = classesOf(<AnchorPin number={1} state="open" />);
    const fill = t[colorToken(c, 'bg-ds-', t)]!;
    const text = t[colorToken(c, 'text-ds-', t)]!;
    const ring = t[colorToken(c, 'ring-ds-', t)]!;
    expect(contrast(fill, WHITE_ART)).toBeGreaterThanOrEqual(3);
    expect(contrast(fill, BLACK_ART)).toBeGreaterThanOrEqual(3);
    expect(contrast(text, fill)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(ring, fill)).toBeGreaterThanOrEqual(3);
    expect(contrast(ring, MID_ART)).toBeGreaterThanOrEqual(3);
  });

  it.each(themes)('⭐%s: 스펙 핀 = 열린 코멘트 핀과 같은 토큰(같은 대비) — 구분은 아이콘', (_n, t) => {
    const a = classesOf(<AnchorPin number={1} state="open" />);
    const s = classesOf(<SpecPinMarker />);
    for (const prefix of ['bg-ds-', 'text-ds-', 'ring-ds-']) expect(colorToken(s, prefix, t)).toBe(colorToken(a, prefix, t));
  });

  it.each(themes)('⭐%s: 가라앉은 핀 — 숫자 글 ↔ 면 색 채움 ≥ 4.5:1, 테두리 ↔ 흰 · 검은 그림 ≥ 3:1', (_n, t) => {
    const c = classesOf(<AnchorPin number={1} state="resolved" />);
    const fill = t[colorToken(c, 'bg-ds-', t)]!;
    const text = t[colorToken(c, 'text-ds-', t)]!;
    const border = t[colorToken(c, 'border-ds-', t)]!;
    expect(contrast(text, fill)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(border, WHITE_ART)).toBeGreaterThanOrEqual(3);
    expect(contrast(border, BLACK_ART)).toBeGreaterThanOrEqual(3);
  });

  it.each(themes)('⭐%s: 임시(draft) 핀 — 숫자 글 ↔ 채움 ≥ 4.5:1, 점선 테두리 ↔ 흰 · 검은 그림 ≥ 3:1', (_n, t) => {
    const c = classesOf(<AnchorPin number={null} state="draft" />);
    const fill = t[colorToken(c, 'bg-ds-', t)]!;
    const text = t[colorToken(c, 'text-ds-', t)]!;
    const border = t[colorToken(c, 'border-ds-', t)]!;
    expect(contrast(text, fill)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(border, WHITE_ART)).toBeGreaterThanOrEqual(3);
    expect(contrast(border, BLACK_ART)).toBeGreaterThanOrEqual(3);
  });

  it('핀 네 가지 상태와 스펙 핀에 옛 색 · 글자 크기 토큰이 하나도 없다', () => {
    const legacy = /(?<![\w-])(?:text-(?:muted-foreground|foreground|info|primary|on-scrim)|bg-(?:info|muted|card|background|primary(?:\/\d+)?|transparent)|border-(?:border|primary)|ring-info(?:\/\d+)?|text-micro)(?![\w-])/;
    const all = [
      ...classesOf(<AnchorPin number={1} state="open" active />),
      ...classesOf(<AnchorPin number={1} state="resolved" />),
      ...classesOf(<AnchorPin number={null} state="draft" />),
      ...classesOf(<SpecPinMarker active />),
    ].join(' ');
    expect(all).not.toMatch(legacy);
  });
});
