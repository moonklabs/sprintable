// story 5048 (T0 · 디자인 결 갈이) ① 토큰 — Desktop App Kit by Figma의 «결의 규칙»(doc chat-first-ui-design-reskin-desktop-app-kit-20261126 §2)이 design-system.css에 그대로 들어 있는지 지킨다.
// 값 하나하나(hex)가 아니라 «규칙»을 단언한다: 글자 단계 · 줄높이 1.5 · 굵기 셋 · 간격 단계 · 조작 높이 40 하나 · 모서리 단계 · 그림자 없음 · 색 역할(무채색 면 · 진한 바탕 하나 · 강조색 없음).
// 되돌리면(옛 13px · 4px 모서리 · 그림자 · 보라 강조색 …) 빨개진다. 대비 · 층 규칙은 design-system.test.ts · layer-rule.test.ts가 따로 지킨다.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, 'design-system.css'), 'utf8');
const theme = css.slice(css.indexOf('@theme inline'));
const themeStatic = css.slice(css.indexOf('@theme {'), css.indexOf('@theme inline'));

function block(selector: string): Record<string, string> {
  const m = css.match(new RegExp(`(?:^|\\n)${selector.replace('.', '\\.')}(?:,\\s*\\.[\\w-]+)*\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`block ${selector} not found`);
  return Object.fromEntries([...m[1].matchAll(/--ds-([\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)].map((x) => [x[1], x[2].toLowerCase()]));
}
const light = block(':root');
const dark = block('.dark');
const themes: Array<[string, Record<string, string>]> = [['라이트', light], ['다크', dark]];

const px = (re: RegExp, src = theme) => { const m = src.match(re); if (!m) throw new Error(`없음: ${re}`); return Number(m[1]); };
const size = (n: string) => px(new RegExp(`--text-ds-${n}:\\s*(\\d+)px;`));
const lh = (n: string) => px(new RegExp(`--text-ds-${n}--line-height:\\s*(\\d+)px;`));
const weight = (n: string) => px(new RegExp(`--text-ds-${n}--font-weight:\\s*(\\d+);`));
const rem = (n: string) => px(new RegExp(`--spacing-${n}:\\s*([\\d.]+)rem;`), themeStatic) * 16;
const radius = (n: string) => px(new RegExp(`--radius-ds-${n}:\\s*(\\d+)px;`));

// OKLab 채도 C — 무채색 판정(키트 결: 면 · 선 · 글자는 색조가 없다)
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
function chroma(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255)) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return Math.hypot(1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s);
}

describe('키트 규칙 ① 글자 — 글꼴 하나 · 굵기 셋 · 줄높이 1.5 · 가장 작은 글자가 16', () => {
  it('⭐기본 UI 글자 16 · Medium(500) · 줄높이 24(1.5) / 설명 · 미리보기 · 자리글 16 · Regular(400)', () => {
    expect([size('body'), lh('body'), weight('body')]).toEqual([16, 24, 500]);
    expect([size('small'), lh('small'), weight('small')]).toEqual([16, 24, 400]);
  });

  it('⭐쪽 제목 24 · Semibold(600) · 자간 -1% / 칸 제목 · 목록의 이름 20 · Medium(500)', () => {
    expect([size('title'), lh('title'), weight('title')]).toEqual([24, 36, 600]);
    expect(theme).toMatch(/--text-ds-title--letter-spacing:\s*-0\.01em;/);
    expect([size('card-title'), lh('card-title'), weight('card-title')]).toEqual([20, 30, 500]);
  });

  it('⭐줄높이는 모든 단에서 1.5(고정폭 칩 · 배지 자리까지)', () => {
    for (const n of ['title', 'card-title', 'body', 'small', 'mono-lg', 'mono-md', 'mono-sm']) expect(lh(n) / size(n), n).toBe(1.5);
  });

  it('⭐16 아래 글자는 고정폭(mono) 칩 · 알약 · 숫자 배지 자리 둘뿐(14) — 쪽 제목 · 이름 · 기본 · 설명 단은 모두 16 이상', () => {
    for (const n of ['title', 'card-title', 'body', 'small', 'mono-lg']) expect(size(n), n).toBeGreaterThanOrEqual(16);
    expect([size('mono-md'), size('mono-sm')]).toEqual([14, 14]);
  });

  it('⭐굵기는 400 · 500 · 600 셋만 쓴다', () => {
    const used = new Set([...theme.matchAll(/--text-ds-[\w-]+--font-weight:\s*(\d+);/g)].map((m) => Number(m[1])));
    expect([...used].every((w) => [400, 500, 600].includes(w))).toBe(true);
  });
});

describe('키트 규칙 ① 크기 · 여백 — 간격 단계 · 조작 높이 40 하나 · 모서리 단계 · 그림자 없음', () => {
  it('⭐간격 단계는 4 · 8 · 12 · 16 · 24 · 32', () => {
    expect(['ds-1', 'ds-2', 'ds-3', 'ds-4', 'ds-6', 'ds-8'].map((n) => rem(n))).toEqual([4, 8, 12, 16, 24, 32]);
  });

  it('⭐조작 높이는 40 하나 — 단추 · 입력 · 검색 · 탭 목록 · 탐색 항목(control-sm · compact · control 셋이 같은 값). 태그만 28', () => {
    expect([rem('ds-control-sm'), rem('ds-compact'), rem('ds-control')]).toEqual([40, 40, 40]);
    expect(rem('ds-tag')).toBe(28);
  });

  it('⭐부품 규격의 큰 높이: 상단 막대 64 · 대화 머리 80 · 대화 목록 줄 88 · 탐색 항목 폭 240', () => {
    expect([rem('ds-bar'), rem('ds-head'), rem('ds-chat-row'), rem('ds-nav-item')]).toEqual([64, 80, 88, 240]);
  });

  it('⭐칸 폭 이름(셸 · 채팅이 읽는다): 왼쪽 탐색 256 · 대화 목록 400 · 옆 프로필 패널 256', () => {
    expect([rem('ds-nav'), rem('ds-chat-list'), rem('ds-side')]).toEqual([256, 400, 256]);
  });

  it('⭐모서리 단계: 8(모든 조작 · 카드 · 태그) · 16(말풍선, 꼬리 쪽 한 귀만 4) · 원(아바타)', () => {
    expect([radius('control'), radius('panel'), radius('tag')]).toEqual([8, 8, 8]);
    expect([radius('bubble'), radius('pill'), radius('tail')]).toEqual([16, 16, 4]);
    expect(radius('circle')).toBeGreaterThanOrEqual(999);
  });

  it('⭐그림자 없음: popup · overlay 모두 none', () => {
    expect(themeStatic).toMatch(/--shadow-ds-popup:\s*none;/);
    expect(themeStatic).toMatch(/--shadow-ds-overlay:\s*none;/);
  });
});

describe('키트 규칙 ① 색 역할 — 글자 셋 · 면 넷 · 선 · 진한 바탕 하나(강조색 없음)', () => {
  it.each(themes)('⭐%s: 면 · 선 · 글자는 무채색(색조 없음, OKLab C < 0.01)', (_n, t) => {
    for (const k of ['background', 'surface', 'surface-raised', 'surface-sunk', 'surface-high', 'surface-highest', 'line', 'line-strong', 'line-control', 'ink', 'ink-2', 'ink-3', 'action-soft', 'mine', 'on-mine', 'on-mine-2', 'on-mine-link'])
      expect(chroma(t[k]!), k).toBeLessThan(0.01);
  });

  it.each(themes)('⭐%s: 진한 바탕 하나 — 주 행동색(action)은 무채색이고 그 위 글자(on-action) · 강조 글자(action-text)도 무채색이다(보라 같은 강조색을 쓰지 않는다)', (_n, t) => {
    for (const k of ['action', 'on-action', 'action-text']) expect(chroma(t[k]!), k).toBeLessThan(0.01);
  });

  it('⭐진한 바탕은 라이트 검정 · 어둠 흰(주 단추 · 보낸 말풍선 자리)', () => {
    expect([light['action'], light['on-action']]).toEqual(['#000000', '#ffffff']);
    expect([dark['action'], dark['on-action']]).toEqual(['#ffffff', '#000000']);
  });

  it.each(themes)('⭐%s: 상태색(내 손 필요 · 성공 · 실패 · 정보)은 뜻을 나르므로 색조를 남긴다(C ≥ 0.05)', (_n, t) => {
    for (const k of ['needs-hand', 'done', 'failed', 'info']) expect(chroma(t[k]!), k).toBeGreaterThanOrEqual(0.05);
  });

  it('⭐보낸 말풍선(mine)은 진한 바탕 — 라이트 검정 + 흰 글자 · 다크 흰 + 검정 글자(주 단추와 같은 쌍)', () => {
    expect([light['mine'], light['on-mine']]).toEqual(['#000000', '#ffffff']);
    expect([dark['mine'], dark['on-mine']]).toEqual(['#ffffff', '#000000']);
  });

  it('⭐라이트의 «패널»(내용 칸)은 흰색이고 글자 본문은 검정(키트: 면 #ffffff · 본문 #000000)', () => {
    expect([light['surface'], light['ink']]).toEqual(['#ffffff', '#000000']);
  });
});
