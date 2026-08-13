/**
 * story #2590 (B) — 런타임 대비 가드(axe-core color-contrast). 주 게이트·최종 authority.
 *
 * (A) 정적 프리필터(verify-cross-element-tint-text.ts)는 «못 재는» 게 본질이다(조건부 조상·
 * 컴포넌트 경계·알파 합성·상태). (B)는 «렌더된 실 픽셀»을 axe-core로 재므로 (A)가 못 보는
 * 교차-요소·교차-계열·상태(hover)·앞으로 생길 것까지 실 맥락에서 전수한다. (A)↔(B) 충돌 시
 * (B) 승(실 픽셀이 authority). (A) 오탐은 `// tint-guard-ok: <이유>`로 표시하되, (B)가 그 줄을
 * 여전히 실측한다.
 *
 * v1 스코프 = «데이터-경량 표면»(settings/onboarding/dashboard/inbox) × 두 테마 × **rest 상태**.
 * 데이터-무거운 flow/kanban은 «CI 시드 vs nightly» 관측 후 조절.
 *
 * ⛔hover 상태는 v1서 뺐다(첫 CI 런 실측 — story #2590 iteration). 40개 인터랙티브를 훑어
 * hover마다 스캔하는 방식은 검출이 «비결정적»이었다(같은 표면이 run 2엔 위반·run 3엔 통과).
 * 게이트는 결정적이어야 하므로(flaky 게이트=무시당해 가드보다 못함) hover는 «특정 known 요소
 * 대상 결정적 스캔»으로 v2에 재도입한다(임의 루프 아님). rest 스캔은 결정적이라 v1의 뼈대다.
 *
 * baseline(can only shrink): 지금 «있는» 대비 위반은 실패시키지 않고, «새로 생긴» 위반만
 * 빨간불(자매 정적 가드와 같은 계약). 첫 CI 런이 현 위반을 드러내면 그 키를 baseline에 시드한다.
 *
 * ⚠️ 이 스펙이 «못 잡는 것»(AC4 선언·다음 사람이 «다 본다」로 오독 않게):
 *   ①이 페이지 목록 밖 화면 ②org 데이터가 있어야만 렌더되는 tint 표면(v1 미포함) ③hover 등
 *   상호작용 상태(v1 미포함·v2 예정) ④색맹(axe color-contrast는 명도만) ⑤같은 색쌍의 다른
 *   인스턴스(키가 색쌍이라 접힘 — 새 «색쌍»은 잡지만 기존 색쌍의 새 자리는 안 잡음, 아래 참조).
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

/** axe violation → 안정 키 = `page::theme::색쌍(fg/bg)`.
 * ⛔axe의 node.target(CSS 셀렉터)은 클래스 «순서»가 런마다 뒤바뀌어(.pt-4.pb-1 ↔ .pb-1.pt-4)
 * 같은 요소가 다른 키를 내 baseline이 절대 수렴하지 않는다(run 2↔3 실측). 그래서 셀렉터를 키에서
 * 뺐다. 색쌍(fg/bg)은 위반의 «결정적 정체»라 안정적이고 의미도 정확하다(«이 fg가 이 bg 위에서
 * 대비 미달»). 대가(AC4): 같은 색쌍의 «다른 인스턴스»는 하나로 접혀 새로는 안 잡힌다 — 그러나
 * 그건 이미 baseline에 있는 «같은 토큰 채무»이고, 진짜 새로운 것(새 색쌍=새 대비버그)은 그대로
 * 잡힌다. 게이트의 결정성을 위해 granularity를 내준 의도된 trade. */
function violationKeys(page: string, theme: string, violations: AxeViolation[]): string[] {
  const keys = new Set<string>();
  for (const v of violations) {
    for (const node of v.nodes) {
      const colorPair = (node.failureSummary ?? '').match(/#[0-9a-f]{3,8}/gi)?.slice(0, 2).join('/') ?? '';
      keys.add(`${page}::${theme}::${colorPair}`);
    }
  }
  return [...keys];
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
}
