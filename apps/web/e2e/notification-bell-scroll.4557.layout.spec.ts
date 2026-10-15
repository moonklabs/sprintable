/**
 * story #4557 — on a wide screen (lg+) the bell panel did not scroll: a mouse wheel moved the list 0px, only the top six or so
 * rows showed, and the rows below and «더 보기» were out of a mouse's reach (Yuna live 2026-10-03 11:02Z · 1440). The popover is
 * a flex column capped at 480px; the panel root was `h-full`, which inside a parent with only a max-height resolves to its
 * content and, as a flex item, does not shrink below it — so the list never got a bounded height to scroll in.
 *
 * Layout is the browser's job (jsdom computes none), so this runs in Chromium: the popover · panel root · header · list are
 * built with the component's OWN class strings, read from notification-bell.tsx, and the real Tailwind build of globals.css for
 * those classes. No server — PLAYWRIGHT_BASE_URL can point anywhere (the page is set directly).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { compile, optimize } from '@tailwindcss/node';

const SRC = path.join(__dirname, '../src/components/nav/notification-bell.tsx');
const APP = path.join(__dirname, '../src/app');

/** the class strings the bell renders for the lg+ panel (drift-proof: read from the source, not copied) */
function classesFromSource() {
  const src = readFileSync(SRC, 'utf8');
  const pick = (re: RegExp, what: string) => { const m = re.exec(src); if (!m) throw new Error(`notification-bell.tsx: ${what} not found`); return m[1]!; };
  return {
    popover: pick(/data-dropdown-panel="notification-bell" className="([^"]+)"/, 'the lg+ popover'),
    maxHeight: Number(pick(/data-dropdown-panel="notification-bell"[^\n]*maxHeight: '(\d+)px'/, 'the popover max height')),
    root: pick(/return \(\s*<div className="([^"]+)">\s*\{\/\* 헤더 \*\/\}/, 'the panel root'),
    mobile: pick(/className="(fixed inset-0[^"]*lg:hidden)"/, 'the < lg full-screen panel'),
    header: pick(/\{\/\* 헤더 \*\/\}\s*<div className="([^"]+)">/, 'the header'),
    list: pick(/\{\/\* 목록 \*\/\}\s*<div className="([^"]+)">/, 'the list'),
  };
}

async function css(classes: string[]): Promise<string> {
  const compiler = await compile(readFileSync(path.join(APP, 'globals.css'), 'utf8'), { base: APP, onDependency: () => {} });
  return (optimize as unknown as (c: string, o?: object) => { code: string })(compiler.build(classes), { minify: false }).code;
}

test('[SID:4557] lg+ bell panel: 30 rows in a 480px popover — the list scrolls under the mouse wheel and the last row and «더 보기» come into reach', async ({ page }) => {
  const c = classesFromSource();
  const rows = Array.from({ length: 30 }, (_, i) => `<div class="row" style="height:64px;border-bottom:1px solid #eee">알림 ${i + 1}</div>`).join('');
  const all = [c.popover, c.root, c.header, c.list].join(' ').split(/\s+/).filter(Boolean);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.setContent(`<!doctype html><html><head><style>${await css(all)}</style></head><body>
    <div id="popover" class="${c.popover}" style="position:absolute;top:40px;right:16px;max-height:${c.maxHeight}px">
      <div id="root" class="${c.root}">
        <div class="${c.header}" style="height:48px">알림</div>
        <div id="list" class="${c.list}">${rows}<button id="more" style="height:40px;width:100%">더 보기</button></div>
      </div>
    </div></body></html>`);
  const list = page.locator('#list');
  const before = await list.evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, top: el.scrollTop }));
  expect(before.clientHeight, 'the list gets a bounded height inside the 480px popover').toBeLessThan(c.maxHeight);
  expect(before.scrollHeight).toBeGreaterThan(before.clientHeight);
  // a person's mouse wheel over the list
  const box = (await list.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 8; i++) await page.mouse.wheel(0, 400);
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  // the end of the list: the last row and «더 보기» inside the popover's visible box
  await expect.poll(() => list.evaluate((el) => Math.round(el.scrollTop + el.clientHeight) >= el.scrollHeight - 1)).toBe(true);
  const pop = (await page.locator('#popover').boundingBox())!;
  const more = (await page.locator('#more').boundingBox())!;
  expect(more.y + more.height).toBeLessThanOrEqual(pop.y + pop.height + 1);
  expect(more.y).toBeGreaterThanOrEqual(pop.y);
});

test('[SID:4557] < lg full-screen panel (390): the list still scrolls inside the screen (the root fix does not break it)', async ({ page }) => {
  const c = classesFromSource();
  const rows = Array.from({ length: 30 }, (_, i) => `<div style="height:64px">알림 ${i + 1}</div>`).join('');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent(`<!doctype html><html><head><style>${await css([c.mobile, c.root, c.header, c.list].join(' ').split(/\s+/).filter(Boolean))}</style></head><body>
    <div class="${c.mobile}"><div class="${c.root}"><div class="${c.header}" style="height:48px">알림</div>
      <div id="list" class="${c.list}">${rows}<button id="more" style="height:40px;width:100%">더 보기</button></div></div></div></body></html>`);
  const list = page.locator('#list');
  const m = await list.evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }));
  expect(m.clientHeight).toBeLessThanOrEqual(844);
  expect(m.scrollHeight).toBeGreaterThan(m.clientHeight);
  const box = (await list.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 8; i++) await page.mouse.wheel(0, 400);
  await expect.poll(() => list.evaluate((el) => Math.round(el.scrollTop + el.clientHeight) >= el.scrollHeight - 1)).toBe(true);
});
