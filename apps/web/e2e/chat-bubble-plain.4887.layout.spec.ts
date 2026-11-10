/**
 * story 4887 (UI-4 P4-b · AC3 B3) — an agent's message has no bubble, measured in Chromium with the component's OWN class strings (read from chat-bubble.tsx) and the real Tailwind build of globals.css.
 * Plain: nothing is drawn behind the text and the text starts exactly where the head line's name starts (no padding box pushes it in). A person's bubble: a drawn fill and the text inset by the bubble's padding.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Browser } from '@playwright/test';
import { compile, optimize } from '@tailwindcss/node';

const BUBBLE = path.join(__dirname, '../src/components/chat/chat-bubble.tsx');
const APP = path.join(__dirname, '../src/app');

function classesFromSource() {
  const src = readFileSync(BUBBLE, 'utf8');
  const base = /<div data-testid="chat-bubble-text" className=\{`([^$`]+)\$\{/.exec(src);
  const pick = /isMine\s*\?\s*'([^']+)'\s*:\s*isAgent\s*\?\s*'([^']+)'\s*:\s*'([^']+)'\s*\}`\}\s*data-bubble=/.exec(src);
  if (!base || !pick) throw new Error('the bubble text box classes not found');
  return { base: base[1]!.trim(), mine: pick[1]!, agent: pick[2]!, person: pick[3]! };
}

async function css(classes: string[]): Promise<string> {
  const compiler = await compile(readFileSync(path.join(APP, 'globals.css'), 'utf8'), { base: APP, onDependency: () => {} });
  return (optimize as unknown as (c: string, o?: object) => { code: string })(compiler.build(classes), { minify: false }).code;
}

async function scene(browser: Browser, kind: 'agent' | 'person' | 'mine') {
  const c = classesFromSource();
  const variant = c[kind];
  const all = [c.base, variant, 'flex min-w-0 max-w-[72%] flex-col gap-0.5 items-start', 'text-editorial-meta font-medium text-muted-foreground'].join(' ').split(/\s+/).filter(Boolean);
  const context = await browser.newContext({ viewport: { width: 700, height: 400 } });
  const page = await context.newPage();
  await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${await css(all)}</style></head><body style="margin:0;background:#fff">
    <div style="padding:8px 120px"><div id="col" class="flex min-w-0 max-w-[72%] flex-col gap-0.5 items-start">
      <div id="headline" class="flex items-center gap-1.5"><span id="name" class="text-editorial-meta font-medium text-muted-foreground">개발 에이전트</span></div>
      <div id="box" class="${c.base} ${variant}"><span id="t">안녕하세요 본문입니다</span></div>
    </div></div></body></html>`);
  const x = (sel: string) => page.locator(sel).evaluate((e) => e.getBoundingClientRect().x);
  const style = (sel: string, prop: string) => page.locator(sel).evaluate((e, p) => getComputedStyle(e).getPropertyValue(p), prop);
  return { context, x, style };
}

test('[SID:4887] an agent\'s message is plain: nothing drawn behind the text, and the text starts where the name starts', async ({ browser }) => {
  const { context, x, style } = await scene(browser, 'agent');
  expect(['rgba(0, 0, 0, 0)', 'transparent']).toContain(await style('#box', 'background-color')); // reverted (a fill) → a colour
  expect(await style('#box', 'padding-left')).toBe('0px'); // reverted (the bubble padding) → 14px
  expect(Math.abs((await x('#t')) - (await x('#name'))), 'the text is flush with the name').toBeLessThanOrEqual(1);
  await context.close();
});

for (const kind of ['person', 'mine'] as const) {
  test(`[SID:4887] ${kind === 'mine' ? 'my' : 'another person\'s'} message keeps its bubble: a drawn fill and the text inset by the padding`, async ({ browser }) => {
    const { context, x, style } = await scene(browser, kind);
    expect(await style('#box', 'background-color'), 'a fill is drawn').not.toMatch(/^rgba\(0, 0, 0, 0\)$|^transparent$/);
    expect(await style('#box', 'padding-left')).toBe('14px');
    expect((await x('#t')) - (await x('#name')), 'the text is inset by the bubble padding').toBeGreaterThanOrEqual(13);
    await context.close();
  });
}
