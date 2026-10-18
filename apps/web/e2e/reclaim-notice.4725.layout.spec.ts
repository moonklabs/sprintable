/**
 * story 4725 decision 2 — the one-time «what was cut» notice at 390 px, light and dark: the real `ReclaimNoticeAlert` (bundled with esbuild, not copied) and the real Tailwind
 * build of globals.css. Two scenes: what a mailed-reset reclaim really leaves (sessions only) and THE LONGEST FORM — the server says all six things were cut and the password was
 * cleared (title + the full list + the password line + [닫기]). Asserted: nothing is wider than the screen, the text is not cut off in the box, the Info icon sits left of the text column and level with the title, and the
 * button's text does not wrap. With CAPTURE_OUT set, the four captures are written there (Yuna asked for them).
 */
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { compile, optimize } from '@tailwindcss/node';
import { layoutStubPlugin } from './support/layout-stubs';

const req = createRequire(__filename);
const WEB = path.join(__dirname, '..');
const APP = path.join(WEB, 'src', 'app');

let built: { js: string; css: string } | null = null;
async function build() {
  if (built) return built;
  const esbuild = req('esbuild') as typeof import('esbuild');
  const bodies: Record<string, string> = { '@/lib/db/client': 'export const fetchWithAuth = (u, i) => fetch(u, i);' };
  const filter = new RegExp(`^(${Object.keys(bodies).map((k) => k.replace(/[/.-]/g, '\\$&')).join('|')})$`);
  const out = await esbuild.build({
    stdin: {
      contents: `
        import React from 'react'; import { createRoot } from 'react-dom/client'; import { NextIntlClientProvider } from 'next-intl';
        import ko from './messages/ko.json'; import en from './messages/en.json';
        import { ReclaimNoticeAlert } from './src/components/auth/reclaim-notice';
        window.__mount = (locale) => {
          createRoot(document.getElementById('root')).render(React.createElement(NextIntlClientProvider, { locale, messages: locale === 'en' ? en : ko, timeZone: 'Asia/Seoul' },
            React.createElement('div', { className: 'mx-auto w-full max-w-md px-4 pt-4' }, React.createElement(ReclaimNoticeAlert))));
        };`,
      resolveDir: WEB, loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', jsx: 'automatic',
    tsconfig: path.join(WEB, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_APP_URL': '"https://app.sprintable.ai"' },
    plugins: [
      { name: 'reclaim-4725-stubs', setup(b) { b.onResolve({ filter }, (a) => ({ path: a.path, namespace: 'stub4725' })); b.onLoad({ filter: /.*/, namespace: 'stub4725' }, (a) => ({ contents: bodies[a.path]!, loader: 'js', resolveDir: WEB })); } },
      layoutStubPlugin(),
    ],
  });
  const js = out.outputFiles[0]!.text;
  const candidates = [...new Set([...js.matchAll(/"([^"\n]+)"/g)].flatMap((m) => m[1]!.split(/\s+/)).filter(Boolean))];
  const compiler = await compile(readFileSync(path.join(APP, 'globals.css'), 'utf8'), { base: APP, onDependency: () => {} });
  const css = (optimize as unknown as (c: string, o?: object) => { code: string })(compiler.build(candidates), { minify: false }).code;
  built = { js, css };
  return built;
}

const SESSIONS_ONLY = { data: { member_id: 'u-1', reclaim_notice: { cut: ['sessions'], password_cleared: false } } };
const LONGEST = { data: { member_id: 'u-1', reclaim_notice: { cut: ['sessions', 'providers', 'two_step', 'keys', 'phones', 'computers'], password_cleared: true } } };

async function open(page: Page, o: { theme: 'L' | 'D'; locale: 'ko' | 'en'; me: unknown }) {
  const { js, css } = await build();
  await page.setViewportSize({ width: 390, height: 600 });
  await page.unrouteAll();
  await page.route('http://preview.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="${o.locale}" class="${o.theme === 'D' ? 'dark' : ''}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-background text-foreground"><div id="root"></div></body></html>` });
    }
    if (url.pathname === '/api/auth/me') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(o.me) });
    return route.fulfill({ status: 404, body: '{}' });
  });
  await page.goto('about:blank');
  await page.goto('http://preview.test/');
  await page.addScriptTag({ content: js });
  await page.evaluate((l) => (window as unknown as { __mount: (l: string) => void }).__mount(l), o.locale);
  await page.getByTestId('reclaim-notice').waitFor();
}

const outDir = () => { const d = process.env['CAPTURE_OUT'] || test.info().outputDir; mkdirSync(d, { recursive: true }); return d; };

for (const theme of ['L', 'D'] as const) {
  for (const [scene, me] of [['sessions-only', SESSIONS_ONLY], ['longest', LONGEST]] as const) {
    test(`390 · ${theme === 'L' ? 'light' : 'dark'} · ${scene}: nothing wider than the screen, text not cut off, icon level with the title, button text on one line`, async ({ page }) => {
      await open(page, { theme, locale: 'ko', me });
      const box = page.getByTestId('reclaim-notice');
      const g = await page.evaluate(() => {
        const el = document.querySelector('[data-testid=reclaim-notice]') as HTMLElement;
        const r = (n: Element | null) => { const b = (n as HTMLElement).getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, h: b.height }; };
        const title = el.querySelector('h5, [data-slot=alert-title], p, div') as HTMLElement;
        const icon = el.querySelector(':scope > svg');
        const btn = el.querySelector('[data-testid=reclaim-notice-close]') as HTMLElement;
        const texts = [...el.querySelectorAll('p, span, div')].filter((n) => (n.children.length === 0) && n.textContent!.trim());
        return {
          docScroll: document.documentElement.scrollWidth, vw: window.innerWidth,
          box: r(el), icon: icon ? r(icon) : null, titleBox: r(title), btn: r(btn),
          btnLines: (() => { const rg = document.createRange(); rg.selectNodeContents(btn); return new Set([...rg.getClientRects()].map((q) => Math.round(q.top))).size; })(),
          overflowing: texts.filter((n) => (n as HTMLElement).scrollWidth > (n as HTMLElement).clientWidth + 1).map((n) => n.textContent!.slice(0, 20)),
        };
      });
      expect(g.docScroll, 'no horizontal scroll').toBeLessThanOrEqual(g.vw);
      expect(g.box.l).toBeGreaterThanOrEqual(0);
      expect(g.box.r).toBeLessThanOrEqual(g.vw);
      expect(g.overflowing, 'a text wider than its box').toEqual([]);
      expect(g.icon, 'the info icon is there').not.toBeNull();
      expect(g.icon!.r, 'the icon is left of the text column').toBeLessThanOrEqual(g.titleBox.l + 1);
      expect(Math.abs((g.icon!.t + g.icon!.b) / 2 - (g.titleBox.t + 12)), 'the icon is level with the title\'s first line').toBeLessThanOrEqual(8);
      expect(g.btn.b, 'the button is inside the box').toBeLessThanOrEqual(g.box.b);
      expect(g.btnLines, 'the button text is one line').toBeLessThanOrEqual(1);
      if (scene === 'longest') {
        await expect(box).toContainText('로그인 상태 · 다른 로그인 방식 · 2단계 인증 · 키 · 등록한 폰과 컴퓨터를 끊었어요');
        await expect(box).toContainText('비밀번호도 비웠어요');
      }
      await page.mouse.move(0, 0);
      await box.screenshot({ path: path.join(outDir(), `4725-390-${theme === 'L' ? 'light' : 'dark'}-${scene}.png`) });
    });
  }
}
