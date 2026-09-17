/**
 * story #4014(유나 시안 7c197474) AC4·AC5/6 — 좁은 폭(390·768)·1440 마케팅 목록 표 3곳
 * (블로그 포스트·채널 포스트·성과 보드)의 자동 실측.
 *
 * CHANGES(페드루 PO 지적, 2026-09-17) — 첫 판은 「행이 0건이면 char-split·칩 검사를
 * 조용히 스킵」했다. 이건 공허 통과다 — 원 결함(#4014 근거)이 애초에 «행이 있을 때만»
 * 보이므로, 빈 목록이면 그 결함이 재발해도 이 스펙이 계속 초록이었을 것. 이제 각 라우트·
 * 폭마다 최소 시드 존재(행 ≥1·칩 ≥1·성과 보드는 「없음」 문구 셀 ≥1)를 먼저 단언한다 —
 * 모자라면 **테스트 자체를 실패**시켜 「시드 부족」을 명시한다(무행=스킵 아님).
 *
 * ⚠️이 스펙이 «못 잡는» 것(card-surface-guard.spec.ts와 동형 선언 관례):
 *   ①이 seed 최소 요건을 만족하는 org가 필요하다(아래 SEED_REQUIREMENTS 주석) — CI
 *     e2e owner org가 빈 org면 이 스펙 자체가 «시드 부족»으로 실패한다(설계대로 —
 *     조용한 통과보다 명시 실패가 맞다는 게 이번 CHANGES의 요지).
 *   ②페이지 가로 넘침 0(ⓐ)·표 감싸개 hidden 구조(ⓓ)는 행 유무와 무관하게 항상 검사된다
 *     (페이지 셸·CSS 계약 자체를 재는 것이라 데이터 의존 0).
 */
import { expect, test, type Page } from '@playwright/test';

test.use({ storageState: './playwright/.auth/owner.json' });

interface RouteSpec {
  path: string;
  label: string;
  rowTestId: string;
  /** 성과 보드만 — 「없음」 문구 셀(muted, 값 없음을 정직하게 알리는 자리) 존재를 추가로
   * 요구한다(원 결함의 「채널 미제공」류 잘림이 실제로 이 자리에서 났었다). */
  noDataTestIds?: string[];
}

// story #4014 CHANGES — 이 스펙이 요구하는 최소 seed 모양(없으면 아래 각 테스트가
// 「시드 부족」으로 명시 실패한다). owner org에 뭉클랩 시드류로 다음을 채워야 한다:
//   - 블로그 포스트 목록: 초안 ≥1건(상태 칩이 뜨는 상태 — draft/pending/approved/published 무관).
//   - 채널 포스트 목록: 초안 ≥1건(마찬가지, 상태 칩 필요).
//   - 성과 보드: 발행물 ≥1건 + 그 중 최소 1건은 d1/d7·댓글·광고비 중 하나가 「없음」류
//     muted 문구로 뜨는 상태(예: hosted_site라 채널 미제공, 또는 아직 집계 전) — 이게
//     원 결함(char-split)의 진앙이라 반드시 필요하다(스토리 근거 §insights-board 390·768).
const ROUTES: RouteSpec[] = [
  { path: '/content', label: '블로그 포스트 목록', rowTestId: 'content-list-row' },
  { path: '/content/channel-posts', label: '채널 포스트 목록', rowTestId: 'channel-posts-list-row' },
  {
    path: '/organization/insights-board', label: '성과 보드', rowTestId: 'insights-board-row',
    noDataTestIds: [
      'insights-board-cell-unscheduled', 'insights-board-cell-status',
      'insights-board-comments-not-applicable', 'insights-board-comments-channel-unsupported',
      'insights-board-comments-uncollected',
    ],
  },
];

const WIDTHS = [390, 768, 1440] as const;

/** ⓑ char-split zero — 텍스트를 품은 요소의 렌더 폭이 40px 미만인 것이 0개. */
async function countNarrowTextNodes(page: Page, containerSelector: string): Promise<number> {
  return page.evaluate((sel) => {
    const container = document.querySelector(sel);
    if (!container) return 0;
    let count = 0;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT);
    let node: Element | null = walker.currentNode as Element;
    while (node) {
      const hasDirectText = [...node.childNodes].some(
        (c) => c.nodeType === Node.TEXT_NODE && (c.textContent ?? '').trim().length > 0,
      );
      if (hasDirectText) {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        if (style.display !== 'none' && rect.width > 0 && rect.width < 40) count++;
      }
      node = walker.nextNode() as Element | null;
    }
    return count;
  }, containerSelector);
}

test.describe('story #4014 — 반응형 마케팅 목록 표', () => {
  for (const route of ROUTES) {
    for (const width of WIDTHS) {
      test(`${route.label} @ ${width}px — 가로 넘침 0 · 표/카드 CSS 계약 · char-split 0`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        const response = await page.goto(route.path);
        expect(response?.status(), `${route.label}@${width}: HTTP status`).toBe(200);
        await page.waitForLoadState('networkidle');

        // ⓐ 페이지 가로 넘침 0(모든 폭·행 유무 무관).
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        );
        expect(overflow, `${route.label}@${width}: 페이지 가로 넘침(px)`).toBeLessThanOrEqual(1);

        // ⓓ 표 감싸개는 CSS(hidden lg:block)로만 좁힌다 — <1024에서 display:none,
        // ≥1024에서 block. 구조 자체가 JS 없이도 SSR/CSS만으로 옳게 좁혀지는지(AC5/6).
        const tableWrapperDisplay = await page.evaluate(() => {
          const table = document.querySelector('table');
          if (!table) return null;
          const wrapper = table.closest('[data-slot="card"]') ?? table.parentElement;
          return wrapper ? getComputedStyle(wrapper).display : null;
        });
        if (tableWrapperDisplay !== null) {
          if (width < 1024) {
            expect(tableWrapperDisplay, `${route.label}@${width}: 표 감싸개 display(<1024는 none)`).toBe('none');
          } else {
            expect(tableWrapperDisplay, `${route.label}@${width}: 표 감싸개 display(≥1024는 none 아님)`).not.toBe('none');
          }
        }

        const cardsWrapperDisplay = await page.evaluate(() => {
          const el = document.querySelector('[data-testid="responsive-data-table-cards"]');
          return el ? getComputedStyle(el).display : null;
        });
        if (cardsWrapperDisplay !== null) {
          if (width < 1024) {
            expect(cardsWrapperDisplay, `${route.label}@${width}: 카드 감싸개 display(<1024는 none 아님)`).not.toBe('none');
          } else {
            expect(cardsWrapperDisplay, `${route.label}@${width}: 카드 감싸개 display(≥1024는 none)`).toBe('none');
          }
        }

        // CHANGES — 좁은 폭에선 카드 wrapper 안쪽만(표는 hidden이라 숨은 사본), 넓은
        // 폭에선 표 안쪽만 스코프한다(같은 testid가 표·카드 두 벌이라 안 좁히면 숨은
        // 쪽까지 같이 잡혀 판정이 흐려진다, 페드루 지적).
        const activeContainerSelector = width < 1024
          ? '[data-testid="responsive-data-table-cards"]'
          : 'table';

        // CHANGES — 시드 최소 요건을 먼저 단언(공허 통과 방지). 모자라면 여기서 명시
        // 실패 — 위 SEED_REQUIREMENTS 주석이 필요한 시드 모양을 적어둔다.
        const rowCount = await page.locator(`${activeContainerSelector} [data-testid="${route.rowTestId}"]`).count();
        expect(rowCount, `${route.label}@${width}: 데이터 행 ≥1 필요(시드 부족 — 이 파일 상단 seed 요건 주석 참고)`).toBeGreaterThanOrEqual(1);

        const chipCount = await page.locator(`${activeContainerSelector} [data-status-chip]`).count();
        expect(chipCount, `${route.label}@${width}: 상태 칩 ≥1 필요(시드 부족)`).toBeGreaterThanOrEqual(1);

        if (route.noDataTestIds) {
          const noDataSelector = route.noDataTestIds.map((id) => `${activeContainerSelector} [data-testid="${id}"]`).join(', ');
          const noDataCount = await page.locator(noDataSelector).count();
          expect(
            noDataCount,
            `${route.label}@${width}: 「없음」류 muted 문구 셀 ≥1 필요(char-split 진앙 — 시드 부족, 이 파일 상단 seed 요건 주석 참고)`,
          ).toBeGreaterThanOrEqual(1);
        }

        // ⓑ char-split zero.
        const narrowCount = await countNarrowTextNodes(page, activeContainerSelector);
        expect(narrowCount, `${route.label}@${width}: 폭<40px 텍스트 노드(char-split)`).toBe(0);

        // ⓒ 상태 칩 1줄(height == 1줄, whitespace-nowrap 계약 실측).
        const chipHeights = await page.evaluate((sel) => {
          const container = document.querySelector(sel);
          if (!container) return [];
          return [...container.querySelectorAll('[data-status-chip]')].map(
            (el) => (el as HTMLElement).getBoundingClientRect().height,
          );
        }, activeContainerSelector);
        const maxHeight = Math.max(...chipHeights);
        const minHeight = Math.min(...chipHeights);
        // 칩마다 상태별 내용은 다를 수 있어도(아이콘 유무 등) 세로로 쪼개지면 높이가
        // 2배 이상 뛴다 — 전부 같은 대(±2px) 안에 있으면 1줄로 본다.
        expect(maxHeight - minHeight, `${route.label}@${width}: 상태 칩 높이 편차(2줄 쪼개짐 감지)`).toBeLessThanOrEqual(2);
      });
    }
  }
});
