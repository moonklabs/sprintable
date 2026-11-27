import type { Locator, Page } from '@playwright/test';

/**
 * The work board's frame (`data-testid="flow-board-frame"`), looked up INSIDE the app's `<main>` — the same rule as helpers/storage-list.ts (story 4892).
 *
 * Why not `page.locator('[data-testid="flow-board-frame"]')`: the CI run 45923586779 (develop 1c764ab87, Contrast guard job, first attempt of «일감 바닥 여백») failed with a
 * strict-mode violation — the bare selector resolved to two elements, `getByRole('main').getByTestId(...)` and `getByTestId(...).nth(1)`. What was MEASURED in that run's trace: the
 * response HTML of `/flow` holds the frame ONCE, at offset 46020, after `</main>` (offset 45436) inside the streaming holder `<div hidden id="S:0">`, which `$RC("B:0","S:0")` moves
 * into `main`; the test looked in the moment both copies exist (`waitUntil: 'domcontentloaded'`). The screen does not draw the board twice.
 *
 * Scoped to `main` it is still strict: a board really drawn twice INSIDE `main` fails with the same strict-mode error (e2e/flow-board-frame-locator.layout.spec.ts proves both).
 * No `.first()`, no longer wait.
 */
export const flowBoardFrame = (page: Page): Locator => page.getByRole('main').getByTestId('flow-board-frame');
