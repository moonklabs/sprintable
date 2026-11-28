// story 5048 (T0) AC4 · Two-Pass 2차 고침 — 일반 `rounded-sm|md|lg|xl|2xl|3xl|4xl` 단이 «ds 눈금»(4 · 8 · 12 · 16)에서만 나온다.
// dev 계산 값에서 옛 `ui/button`(`rounded-md` = 6.4px) · `rounded-sm`(4.8px) · 셸 `rounded-xl`(11.2px)이 눈금 밖으로 읽혔다 — `--radius`에 곱을 한 파생(×0.6 · ×0.8 · ×1.4 …)이 원인.
// 값은 design-system.css의 `--radius-ds-*`가 정하고, globals.css의 이 줄들은 이름만 잇는다(곱 `calc()` 0 — 되돌리면 RED).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const globals = readFileSync(join(__dirname, '..', 'app', 'globals.css'), 'utf8');
const ds = readFileSync(join(__dirname, 'design-system.css'), 'utf8');
const SCALE = ['sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl'] as const;
const dsPx = (n: string): number => { const m = ds.match(new RegExp(`--radius-ds-${n}:\\s*(\\d+)px;`)); if (!m) throw new Error(`--radius-ds-${n} 없음`); return Number(m[1]); };
const decl = (step: string): string => { const m = globals.match(new RegExp(`--radius-${step}:\\s*([^;]+);`)); if (!m) throw new Error(`--radius-${step} 없음`); return m[1]!.trim(); };
/** 한 줄의 값을 px로 푼다: `var(--radius-ds-x)` → ds 토큰 · `var(--radius)` → `--radius`(rem) — 그 밖(곱 calc · 직접 px)은 null */
function resolve(v: string): number | null {
  const d = v.match(/^var\(--radius-ds-([\w-]+)\)$/); if (d) return dsPx(d[1]!);
  if (v === 'var(--radius)') { const r = globals.match(/--radius:\s*([\d.]+)rem;/); return r ? Number(r[1]) * 16 : null; }
  return null;
}

describe('모서리 단(rounded-sm … 4xl)은 ds 눈금에서만 — 5048 AC4 2차 고침', () => {
  it.each(SCALE)('⭐--radius-%s는 ds 토큰 이름이거나 --radius 그대로다(곱 calc · 직접 px 0)', (step) => {
    expect(decl(step), `--radius-${step}`).toMatch(/^var\(--radius(?:-ds-[\w-]+)?\)$/);
  });
  it('⭐풀린 값은 전부 {4 · 8 · 12 · 16} 안이다(6.4 · 11.2 · 14.4 · 17.6 · 20.8 같은 눈금 밖 값 0)', () => {
    const px = SCALE.map((s) => resolve(decl(s)));
    expect(px).toEqual([4, 8, 8, 12, 16, 16, 16]);
    for (const v of px) expect([4, 8, 12, 16]).toContain(v);
  });
  it('눈금의 바탕 값은 그대로다: tail 4 · control 8 · bubble 12 · pill 16(kit-rules.5048이 값을 지킴)', () => {
    expect([dsPx('tail'), dsPx('control'), dsPx('bubble'), dsPx('pill')]).toEqual([4, 8, 12, 16]);
  });
});
