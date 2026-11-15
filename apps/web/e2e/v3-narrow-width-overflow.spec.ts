/**
 * story #4006(critical, 5pt) AC3 — 390·768·1440 세 폭에서 v3 화면 가로 넘침 0을
 * document.documentElement.scrollWidth <= innerWidth로 자동 단언한다(3998 결함③의
 * 근거 재현·재발 방지). 「가설」(story #3989, PR #4383)이 develop에 착지해(2026-09-22)
 * 6화면(오늘·대화·연결·규칙·일감·가설·결과) 전부 단언한다.
 *
 * 이 spec은 TODAY_V3_ENABLED/CHAT_V3_ENABLED/CONNECT_RULES_V3_ENABLED=true 전제라
 * ci.yml의 전용 스텝(contrast-guard-e2e job의 «v3 플래그 서버» — 같은 프로덕션 빌드를 `next start`로 한 번 더 띄움 · story #4927)에서만
 * 돈다 — contrast-guard/card-surface e2e와 같은 job의 env를 공유하지 않는다(그 스펙들은
 * v3 플래그 OFF 기준을 전제로 해 오염을 막는다).
 */
import { expect, test, type Page } from '@playwright/test';

test.use({ storageState: 'playwright/.auth/owner.json' });

const WIDTHS = [390, 768, 1440] as const;

// bare 경로 — /today·/chat·/connect-rules는 v3 화면 자체가 (authenticated) 밖 독립
// 라우트 그룹(플래그 ON 전제, 이 spec의 존재 이유). /work-list·/hypotheses는 proxy.ts의
// MIGRATED_RESOURCES bare-path 301 안전망이 실 {ws}/{proj}로 보정(레포 기존 관례,
// card-surface-guard.spec.ts와 동형, legacy-resource-tables.ts에 둘 다 등재 확認).
// /organization/insights-board는 이미 org-scope 최상위 라우트라 그대로.
const SCREENS: Array<{ path: string; label: string }> = [
  { path: '/today', label: '오늘' },
  { path: '/chat', label: '대화' },
  { path: '/connect-rules', label: '연결·규칙' },
  { path: '/work-list', label: '일감' },
  { path: '/hypotheses', label: '가설' },
  { path: '/organization/insights-board', label: '결과' },
];

async function scrollWidthOverflow(page: Page): Promise<{ scrollWidth: number; innerWidth: number }> {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
}

// story #4927 — the width check below passes on ANY page: a server WITHOUT the v3 flags answers /today · /chat · /connect-rules with a bare «Loading…» shell
// (measured: 86 characters of text, no «Connections & Rules» in the nav) and that shell has no overflow either. CI starts this spec's server with the three
// flags (a second `next start` on the same build) — these tests fail when it is not that server, so a width pass means a v3 screen was measured.
test.describe('이 서버는 v3 플래그가 켜져 있다 — 꺼진 서버는 같은 주소에 «Loading…» 껍데기만 내고, 가로 넘침 시험은 그 껍데기도 통과한다', () => {
  test.use({ locale: 'en-US' });
  const bodyText = async (page: Page): Promise<string> => (await page.locator('body').textContent()) ?? '';
  test('/today: 화면 본문(검색 · 지시 칸)과 내비의 «Connections & Rules»가 그려진다', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/today', { waitUntil: 'domcontentloaded' });
    await expect.poll(() => bodyText(page), { timeout: 15_000 }).toContain('Search or give an instruction');
    expect(await bodyText(page)).toContain('Connections & Rules');
  });
  test('/connect-rules: 화면 본문이 그려진다', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/connect-rules', { waitUntil: 'domcontentloaded' });
    await expect.poll(() => bodyText(page), { timeout: 15_000 }).toContain('Connections & rules');
  });
  test('/chat: 대화 화면(chat-v3-screen)이 그려진다(꺼진 서버의 껍데기엔 없음)', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/chat', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('chat-v3-screen')).toBeAttached({ timeout: 15_000 });
  });
});

for (const { path: screenPath, label } of SCREENS) {
  test.describe(`v3 좁은 폭 가로 넘침 0 — ${label}(${screenPath})`, () => {
    for (const width of WIDTHS) {
      test(`${width}px — scrollWidth <= innerWidth`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(screenPath, { waitUntil: 'domcontentloaded' });
        // v3 화면은 SSE/폴링이 계속 돌아 networkidle이 영영 안 온다(story #4160 선례,
        // 같은 클래스 — chat-v3/today-v3 둘 다 (authenticated) 밖이라 그 문제를 그대로
        // 물려받는다). 화면이 실제로 그려졌다는 신호로 body 자식 노드 존재만 확認.
        await page.locator('body').waitFor({ state: 'visible' });
        await page.waitForTimeout(300);
        const { scrollWidth, innerWidth } = await scrollWidthOverflow(page);
        expect(
          scrollWidth,
          `${label}(${screenPath}) @${width}px — scrollWidth(${scrollWidth}) > innerWidth(${innerWidth}), 가로 넘침(story #4006 AC3 위반)`,
        ).toBeLessThanOrEqual(innerWidth);
      });
    }
  });
}
