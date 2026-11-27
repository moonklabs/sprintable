/**
 * The lookup of the work board's frame (e2e/helpers/flow-board-frame.ts), on a page built by hand (no server · no sign-in; runs in the layout e2e).
 *
 * Measured in the CI run that failed (run 45923586779, develop 1c764ab87): `/flow`'s response holds the frame once, after `</main>`, in a hidden streaming holder that `$RC` moves into
 * `main` — the bare `[data-testid="flow-board-frame"]` saw both copies for a moment (strict-mode violation). The helper scopes the lookup to `main`: that moment resolves to exactly
 * one, and a board really drawn twice INSIDE `main` still fails with a strict-mode violation (no `.first()`, no longer wait).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { flowBoardFrame } from './helpers/flow-board-frame';

const FRAME = '<div data-testid="flow-board-frame" style="height:120px">board</div>';
// what the server sent: the page shell with the board streamed into a hidden holder after `main` (moved into `main` by $RC) — both copies exist for a moment
const STREAMING_LEFTOVER = `<main><div data-testid="b0">${FRAME}</div></main><div hidden id="S:0">${FRAME}</div>`;
const DRAWN_TWICE_IN_MAIN = `<main>${FRAME}${FRAME}</main>`;

test('the bare testid sees the hidden holder too (why the old lookup was strict-violated); the helper sees only the frame inside main', async ({ page }) => {
  await page.setContent(STREAMING_LEFTOVER);
  await expect(page.locator('[data-testid="flow-board-frame"]')).toHaveCount(2);   // what failed in CI
  await expect(flowBoardFrame(page)).toHaveCount(1);
  await flowBoardFrame(page).waitFor({ state: 'attached', timeout: 2000 });         // no strict-mode violation
});

test('⭐a board drawn twice INSIDE main is still a strict-mode failure (the helper does not hide a real double)', async ({ page }) => {
  await page.setContent(DRAWN_TWICE_IN_MAIN);
  await expect(flowBoardFrame(page)).toHaveCount(2);
  await expect(flowBoardFrame(page).waitFor({ state: 'attached', timeout: 2000 })).rejects.toThrow(/strict mode violation/);
});

test('the mobile-width spec looks at the board only through the helper (no bare testid · no unscoped details left in the flow block)', async () => {
  const src = readFileSync(path.join(__dirname, 'mobile-width-overflow.spec.ts'), 'utf8');
  expect(src).not.toMatch(/page\.locator\('\[data-testid="flow-board-frame"\]'\)/);
  expect(src).not.toMatch(/document\.querySelector<HTMLElement>\('\[data-testid="flow-board-frame"\]'\)/);
  expect(src.match(/flowBoardFrame\(page\)/g)?.length).toBeGreaterThanOrEqual(2);
});

test('each run of the seed block gets its OWN project (a retried serial group must not stack rows into the project the first attempt filled)', async () => {
  const src = readFileSync(path.join(__dirname, 'mobile-width-overflow.spec.ts'), 'utf8');
  expect(src).not.toMatch(/slug === 'overflow-guard'/);                       // no find-the-old-project path any more
  expect(src).toMatch(/slug: `overflow-guard-\$\{stamp\}`/);                  // a project named by this run's stamp
});
