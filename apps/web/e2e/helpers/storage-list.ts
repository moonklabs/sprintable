import type { Locator, Page } from '@playwright/test';

/**
 * story 4892 — the storage screen's asset list, looked up INSIDE the app's `<main>`.
 *
 * Why not `page.locator('[data-testid="storage-asset-list"]')`: the CI run of PR 5559 (job 130197530011, first attempt) failed with a strict-mode violation — the bare
 * selector resolved to two sections, and Playwright's own report names them `getByRole('main').getByTestId(...)` and `getByTestId(...).nth(1)`: the second one is NOT inside
 * `main`. What was MEASURED: the response HTML saved in that run's trace holds the list ONCE, inside a streaming holder `<div hidden id="S:1">` that sits after `</main>` and is
 * moved into `main` by `$RC("B:1","S:1")`; five loads of the dev app at 402px never showed more than one match. What is NOT measured (a guess): which of the two was
 * hidden at that moment, and why the holder was still around (hydration and the end of the stream arriving out of step).
 *
 * The screen does not draw its list twice outside `main`; scoping the lookup to `main` is still strict — if the screen really drew the list twice INSIDE `main`, this
 * locator would still fail with the same strict-mode error (e2e/storage-list-locator.4892.layout.spec.ts proves both). No `.first()`, no longer wait.
 */
export const storageAssetList = (page: Page): Locator => page.getByRole('main').getByTestId('storage-asset-list');
