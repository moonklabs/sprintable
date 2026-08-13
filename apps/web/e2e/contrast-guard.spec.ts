/**
 * story #2590 (B) — 런타임 대비 가드(axe-core color-contrast). 주 게이트·최종 authority.
 *
 * (A) 정적 프리필터(verify-cross-element-tint-text.ts)는 «못 재는» 게 본질이다(조건부 조상·
 * 컴포넌트 경계·알파 합성·상태). (B)는 «렌더된 실 픽셀»을 axe-core로 재므로 (A)가 못 보는
 * 교차-요소·교차-계열·상태(hover)·앞으로 생길 것까지 실 맥락에서 전수한다. (A)↔(B) 충돌 시
 * (B) 승(실 픽셀이 authority). (A) 오탐은 `// tint-guard-ok: <이유>`로 표시하되, (B)가 그 줄을
 * 여전히 실측한다.
 *
 * v1 스코프(PO 확定) = «데이터-경량 표면»(error/dialog/status/onboarding/settings tint는 org
 * 시드 거의 불요) × 두 테마 × rest+hover. 데이터-무거운 flow/kanban은 «CI 시드 vs nightly»
 * 관측 후 조절(예방은 PR서 유지·비용은 관측 후 — gate 결정과 동형).
 *
 * baseline(can only shrink): 지금 «있는» 대비 위반은 실패시키지 않고, «새로 생긴» 위반만
 * 빨간불(자매 정적 가드와 같은 계약). 첫 CI 런이 현 위반을 드러내면 그 키를 baseline에 시드한다.
 *
 * ⚠️ 이 스펙이 «못 잡는 것»(AC4 선언·다음 사람이 «다 본다」로 오독 않게):
 *   ①이 페이지 목록 밖 화면 ②org 데이터가 있어야만 렌더되는 tint 표면(v1 미포함) ③모달·팝오버 등
 *   상호작용으로만 열리는 상태 중 아래서 명시 오픈 안 한 것 ④색맹(axe color-contrast는 명도만).
 */
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// axe 결과의 최소 shape만 로컬로 둔다(패키지 타입 export에 의존 안 함·shape는 axe-core 안정 계약).
interface AxeNode { target: string[]; failureSummary?: string; }
interface AxeViolation { id: string; nodes: AxeNode[]; }

test.use({ storageState: './playwright/.auth/owner.json' });

const BASELINE_PATH = path.join(__dirname, 'contrast-axe-baseline.json');
function loadBaseline(): Set<string> {
  try {
    return new Set((JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as { keys: string[] }).keys);
  } catch {
    return new Set();
  }
}
const BASELINE = loadBaseline();

// v1 데이터-경량 표면. 각 항목은 그 화면이 렌더하는 tint 표면을 노린다(감사 SSOT 75f15ba7 참조).
const PAGES: Array<{ path: string; label: string }> = [
  { path: '/settings', label: 'settings(danger-zone·gate-matrix·access-tint)' },
  { path: '/onboarding', label: 'onboarding(connect-step info-tint)' },
  { path: '/dashboard', label: 'dashboard(status/tint 위젯)' },
  { path: '/inbox', label: 'inbox(decisions-waiting warning·approvals-queue tint)' },
];
const THEMES = ['light', 'dark'] as const;

/** axe violation → 안정 키(page::theme::selector::색쌍). 색쌍은 failureSummary에서 뽑아 selector
 * 흔들림을 보완한다(PO: selector+color-pair). */
function violationKeys(page: string, theme: string, violations: AxeViolation[]): string[] {
  const keys: string[] = [];
  for (const v of violations) {
    for (const node of v.nodes) {
      const colorPair = (node.failureSummary ?? '').match(/#[0-9a-f]{3,8}/gi)?.slice(0, 2).join('/') ?? '';
      keys.push(`${page}::${theme}::${node.target.join(' ')}::${colorPair}`);
    }
  }
  return keys;
}

async function setTheme(page: Page, theme: string): Promise<void> {
  await page.addInitScript((t) => window.localStorage.setItem('theme', t), theme);
  await page.reload({ waitUntil: 'domcontentloaded' });
  // SSE 앱이라 networkidle이 안 서므로 domcontentloaded + 짧은 정착 대기(#dev-pixel 교훈).
  await page.waitForTimeout(1200);
}

async function scanContrast(page: Page): Promise<AxeViolation[]> {
  const results = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();
  return results.violations as unknown as AxeViolation[];
}

for (const { path: pagePath, label } of PAGES) {
  for (const theme of THEMES) {
    test(`대비(rest) ${label} [${theme}]`, async ({ page }) => {
      await page.goto(pagePath, { waitUntil: 'domcontentloaded' });
      await setTheme(page, theme);
      const violations = await scanContrast(page);
      const fresh = violationKeys(pagePath, theme, violations).filter((k) => !BASELINE.has(k));
      expect(fresh, `새 대비 위반 ${pagePath}[${theme}] — tint 위 계열색 글자는 text-foreground(#2420). 오탐이면 (A)에 tint-guard-ok, 여기선 baseline 시드.`).toEqual([]);
    });
  }

  // hover 상태 — hover에서만 pale bg가 붙는 자리(doc-gate approve/reject·삭제 버튼 등)를 잡는다.
  test(`대비(hover) ${label} [light]`, async ({ page }) => {
    await page.goto(pagePath, { waitUntil: 'domcontentloaded' });
    await setTheme(page, 'light');
    const fresh: string[] = [];
    const interactives = page.locator('button:visible, a:visible, [role="button"]:visible');
    const n = Math.min(await interactives.count(), 40); // v1 상한(관측 후 조절)
    for (let i = 0; i < n; i++) {
      const el = interactives.nth(i);
      try {
        await el.hover({ timeout: 800 });
      } catch {
        continue; // 가려짐/이동 등은 건너뛴다
      }
      const violations = await scanContrast(page);
      fresh.push(...violationKeys(pagePath, `light-hover`, violations).filter((k) => !BASELINE.has(k)));
    }
    expect([...new Set(fresh)], `새 hover 대비 위반 ${pagePath} — hover서만 tint가 붙는 자리(#2420 상태 축).`).toEqual([]);
  });
}
