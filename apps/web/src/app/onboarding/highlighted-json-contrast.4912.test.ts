// story 4912 (C2a · PO + codex) — HighlightedJson is shared by TWO faces: the agent detail's connection card (ds `surface-sunk`) and the onboarding connect step (`bg-muted/40` = the legacy proof-sunk at 40% over the card's proof-panel).
// The three colours (keys · strings · punctuation) must hold 4.5:1 on BOTH faces in light and dark — computed from the real token values, so a token or class change goes red.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dsCss = readFileSync(join(__dirname, '..', '..', 'styles', 'design-system.css'), 'utf8');
const globalsCss = readFileSync(join(__dirname, '..', 'globals.css'), 'utf8');
const connectStep = readFileSync(join(__dirname, 'connect-step.tsx'), 'utf8');

const hex = (h: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
const lin = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const rel = (rgb: number[]) => 0.2126 * lin(rgb[0]!) + 0.7152 * lin(rgb[1]!) + 0.0722 * lin(rgb[2]!);
const contrast = (a: number[], b: number[]) => { const [hi, lo] = [rel(a), rel(b)].sort((x, y) => y - x) as [number, number]; return (hi + 0.05) / (lo + 0.05); };
const blend = (fg: number[], bg: number[], alpha: number) => fg.map((f, i) => alpha * f + (1 - alpha) * bg[i]!);

function dsBlock(selector: ':root' | '.dark'): Record<string, string> {
  const m = dsCss.match(new RegExp(`(?:^|\\n)${selector.replace('.', '\\.')}(?:,\\s*\\.[\\w-]+)*\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`block ${selector} not found`);
  return Object.fromEntries([...m[1]!.matchAll(/--ds-([\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)].map((x) => [x[1]!, x[2]!.toLowerCase()]));
}
// the legacy proof tokens: the first set in globals.css is light, the second dark
const proof = (name: 'sunk' | 'panel'): [string, string] => {
  const all = [...globalsCss.matchAll(new RegExp(`--proof-${name}:\\s*(#[0-9a-fA-F]{6})`, 'g'))].map((m) => m[1]!);
  return [all[0]!, all[1]!];
};

// the class → token the component uses (read from the component, not copied here)
const CLASS_OF = { keys: 'text-ds-action-text', strings: 'text-ds-info', punctuation: 'text-ds-ink-3' } as const;
const TOKEN_OF = { keys: 'action-text', strings: 'info', punctuation: 'ink-3' } as const;

describe('HighlightedJson — 두 면 위 글자색 대비(story 4912 · C2a)', () => {
  it('⭐컴포넌트가 세 색에 정해 둔 ds 토큰 클래스를 쓴다(옛 text-success / text-muted-foreground / text-primary로 돌아가면 RED)', () => {
    // the component's code without its comments (a comment may name the old tokens to explain the change)
    const body = connectStep.slice(connectStep.indexOf('export function HighlightedJson'), connectStep.indexOf('export function ConnectStep'))
      .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    for (const c of Object.values(CLASS_OF)) expect(body, c).toContain(`'${c}'`);
    expect(body).not.toMatch(/text-(success|muted-foreground|primary)\b/);
  });

  for (const [theme, selector, idx] of [['라이트', ':root', 0], ['다크', '.dark', 1]] as const) {
    it(`⭐${theme}: 키 · 문자열 · 부호가 상세 면(surface-sunk)과 온보딩 면(muted/40 on card) 위에서 4.5:1 이상`, () => {
      const t = dsBlock(selector);
      const detailFace = hex(t['surface-sunk']!);
      const onboardingFace = blend(hex(proof('sunk')[idx]!), hex(proof('panel')[idx]!), 0.4);
      for (const k of ['keys', 'strings', 'punctuation'] as const) {
        const fg = hex(t[TOKEN_OF[k]]!);
        expect(contrast(fg, detailFace), `${theme} ${k} on the detail face`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(fg, onboardingFace), `${theme} ${k} on the onboarding face`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  it('재현 가드: 옛 색(text-success ≈ ds done · 라이트)은 상세 눌린 면 위에서 4.5:1 아래였다 — 이 계산이 그것을 잡는다', () => {
    const t = dsBlock(':root');
    expect(contrast(hex(t['done']!), hex(t['surface-sunk']!))).toBeLessThan(4.5);
  });
});
