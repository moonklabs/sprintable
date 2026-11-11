/**
 * story 4892 — the lookup of the storage screen's asset list (e2e/helpers/storage-list.ts), on a page built by hand (no server · no sign-in; runs in the layout e2e).
 *
 * Measured in the CI run that failed (PR 5559, job 130197530011): the bare `[data-testid="storage-asset-list"]` resolved to two sections, the second NOT inside `main`
 * (a hidden streaming holder after `</main>`). The helper scopes the lookup to `main`: that case resolves to exactly one, and a screen that really drew the list twice
 * INSIDE `main` still fails with a strict-mode violation (no `.first()`, no longer wait).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { storageAssetList } from './helpers/storage-list';

const LIST = '<section data-testid="storage-asset-list">list</section>';
// what the server sent: the page shell with the list streamed into a hidden holder after `main` (moved into `main` by $RC) — both copies exist for a moment
const STREAMING_LEFTOVER = `<main><div data-testid="b1">${LIST}</div></main><div hidden id="S:1">${LIST}</div>`;
const DRAWN_TWICE_IN_MAIN = `<main>${LIST}${LIST}</main>`;

test('the bare testid sees the hidden holder too (why the old lookup was strict-violated); the helper sees only the list inside main', async ({ page }) => {
  await page.setContent(STREAMING_LEFTOVER);
  await expect(page.locator('[data-testid="storage-asset-list"]')).toHaveCount(2);   // what failed in CI
  await expect(storageAssetList(page)).toHaveCount(1);
  await storageAssetList(page).waitFor({ timeout: 2000 });                            // no strict-mode violation
  expect(await storageAssetList(page).evaluate((e) => e.getBoundingClientRect().width)).toBeGreaterThan(0);
});

test('⭐a list drawn twice INSIDE main is still a strict-mode failure (the helper does not hide a real double)', async ({ page }) => {
  await page.setContent(DRAWN_TWICE_IN_MAIN);
  await expect(storageAssetList(page)).toHaveCount(2);
  await expect(storageAssetList(page).waitFor({ timeout: 2000 })).rejects.toThrow(/strict mode violation/);
});

test('the mobile-width spec uses the helper for every look at the list (no bare testid lookup left)', async () => {
  const src = readFileSync(path.join(__dirname, 'mobile-width-overflow.spec.ts'), 'utf8');
  expect(src).not.toMatch(/page\.locator\('\[data-testid="storage-asset-list/);        // neither the list nor its body (the body sits inside the list, so a hidden holder has one too)
  expect(src.match(/storageAssetList\(page\)/g)?.length).toBeGreaterThanOrEqual(4);
});
