/**
 * story 4891 (UI-8 · settings › profile · piece ② «알림 도착지 · 차단 목록») — the two list cards (where the notifications go · the people I blocked) and the profile photo card above them (the part piece ① left on old parts: «사진 바꾸기» 28 px · the 10 px hint), measured in Chromium on a touch phone (390 × 844): the REAL components
 * (bundled with esbuild, not copied) and the real Tailwind build. Rule: every press is ≥ 44 × 44, no visible text is under 12 px, no row runs past its edge; the handlers and the values are the old ones.
 */
import { readFileSync } from 'node:fs';
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
  const bodies: Record<string, string> = {
    '@/lib/db/client': "export const fetchWithAuth = (u, i) => fetch(u, i);",
    'next/navigation': "export function useRouter() { return { push() {}, replace() {}, back() {}, refresh() {}, prefetch() {} }; } export function useSearchParams() { return new URLSearchParams(''); } export function usePathname() { return '/settings'; }",
  };
  const filter = new RegExp(`^(${Object.keys(bodies).map((k) => k.replace(/[/.-]/g, '\\$&')).join('|')})$`);
  const out = await esbuild.build({
    stdin: {
      contents: `
        import React from 'react'; import { createRoot } from 'react-dom/client'; import { NextIntlClientProvider } from 'next-intl';
        import ko from './messages/ko.json';
        import { ToastProvider } from './src/components/ui/toast';
        import { MyNotificationChannelSection } from './src/components/settings/my-notification-channel-section';
        import { BlockedUsersSection } from './src/components/settings/blocked-users-section';
        import { AvatarEditCard } from './src/components/shared/avatar-edit-card';
        window.__mount = () => {
          createRoot(document.getElementById('root')).render(React.createElement(NextIntlClientProvider, { locale: 'ko', messages: ko, timeZone: 'Asia/Seoul' }, React.createElement(ToastProvider, null,
            React.createElement('div', { style: { padding: '16px', display: 'grid', gap: '12px' } },
              React.createElement(AvatarEditCard, { memberId: 'm-me', name: '김지우', avatarUrl: 'https://preview.test/a.png', actorType: 'human', onUpdated() {} }),
              React.createElement(MyNotificationChannelSection, { projectId: 'p1', projectName: 'Alpha' }),
              React.createElement(BlockedUsersSection)))));
        };`,
      resolveDir: WEB, loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', jsx: 'automatic',
    tsconfig: path.join(WEB, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_APP_URL': '"https://app.sprintable.ai"', 'process.env.NEXT_PUBLIC_OAUTH_ENABLED': '"true"' },
    plugins: [
      { name: 'profile2-4891-stubs', setup(b) {
        b.onResolve({ filter }, (a) => ({ path: a.path, namespace: 'stub4891p' }));
        b.onLoad({ filter: /.*/, namespace: 'stub4891p' }, (a) => ({ contents: bodies[a.path]!, loader: 'js', resolveDir: WEB }));
      } },
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

type Hook = { id: string; member_id: string; url: string; project_id: string | null; is_active: boolean };
let hooks: Hook[] = [];
let origHooks: Hook[] = [];
let putBody: { member_id: string; url: string; project_id: string | null; is_active: boolean } | null = null;

async function open(page: Page, width: number, height: number) {
  // one on the current project, one on another project (off · a very long project name), one for every project (on → the «turn it off» warning is drawn too)
  hooks = [
    { id: 'w1', member_id: 'm-me', url: 'https://hooks.example.com/services/T000/B000/xxxxxxxxxxxxxxxxxxxxxxxx', project_id: 'p1', is_active: true },
    { id: 'w2', member_id: 'm-me', url: 'https://hooks.example.com/services/T111/B111/yyyyyyyyyyyyyyyyyyyyyyyy', project_id: 'p2', is_active: false },
    { id: 'w3', member_id: 'm-me', url: 'https://hooks.example.com/services/T222/B222/zzzzzzzzzzzzzzzzzzzzzzzz', project_id: null, is_active: true },
  ];
  origHooks = hooks.map((h) => ({ ...h }));
  putBody = null;
  const { js, css } = await build();
  await page.setViewportSize({ width, height });
  await page.unrouteAll();
  await page.route('http://preview.test/**', async (route) => {
    const url = new URL(route.request().url());
    const json = (data: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
    if (url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-ds-canvas text-ds-ink"><div id="root"></div></body></html>` });
    }
    if (url.pathname === '/api/me') return json({ data: { id: 'm-me' } });
    if (url.pathname === '/api/projects') return json({ data: [{ id: 'p1', name: 'Alpha' }, { id: 'p2', name: 'Beta project with a very very long name that must be cut inside its tag and never push the row' }] });
    if (url.pathname === '/api/webhooks/config' && route.request().method() === 'PUT') {
      const b = JSON.parse(route.request().postData() ?? '{}') as { member_id: string; url: string; project_id: string | null; is_active: boolean };
      const c = hooks.find((h) => h.url === b.url); if (c) c.is_active = b.is_active;
      putBody = b;
      return json({ data: c ?? {} });
    }
    if (url.pathname === '/api/webhooks/config') return json({ data: hooks });
    if (url.pathname === '/api/user-blocks') {
      return json([
        { blocked_member_id: 'b1', created_at: '2026-11-01T00:00:00Z', blocked_member_name: '김지우' },
        { blocked_member_id: 'b2', created_at: '2026-11-02T00:00:00Z', blocked_member_name: 'A very long display name that must not push the unblock press out of its row' },
      ]);
    }
    return route.fulfill({ status: 404, body: '{}' });
  });
  await page.addInitScript(() => { (window as unknown as { process: unknown }).process = { env: {} }; });
  await page.goto('about:blank');
  await page.goto('http://preview.test/');
  await page.addScriptTag({ content: js });
  await page.evaluate(() => (window as unknown as { __mount: () => void }).__mount());
  await page.getByRole('switch').first().waitFor();
  await page.getByRole('button', { name: '사진 변경' }).waitFor();
  await page.getByRole('heading', { level: 2 }).nth(1).waitFor();
}

const measure = (page: Page) => page.evaluate(() => {
  const vis = (e: Element) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const presses = [...document.querySelectorAll('button, [role=switch], a[href], input, select, summary')].filter(vis);
  const small = presses.filter((e) => { const r = e.getBoundingClientRect(); return r.width < 43.5 || r.height < 43.5; }).map((e) => `${(e.getAttribute('aria-label') || e.textContent || e.tagName).trim().slice(0, 14)} ${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`);
  const leaves = [...document.querySelectorAll('body *')].filter((e) => e.children.length === 0 && (e.textContent || '').trim() && vis(e));
  const tiny = leaves.filter((e) => parseFloat(getComputedStyle(e).fontSize) < 12).map((e) => `${(e.textContent || '').trim().slice(0, 14)} ${getComputedStyle(e).fontSize}`);
  // a row (destination / blocked person) whose controls run past its own right edge
  const rows = [...document.querySelectorAll('[data-slot="ds-list-row"], [data-slot="ds-card"] .divide-y > div')];
  const clipped = rows.filter((row) => { const rr = row.getBoundingClientRect(); return [...row.querySelectorAll('button, [role=switch]')].some((c) => c.getBoundingClientRect().right > rr.right + 0.5); }).length;
  const tagOut = [...document.querySelectorAll('.rounded-ds-tag')].filter((t) => { const row = t.closest('[data-slot="ds-card"] .divide-y > div, [data-slot="ds-card"]'); return !!row && (t.getBoundingClientRect().right > row.getBoundingClientRect().right + 0.5 || t.scrollWidth > t.clientWidth + 1); }).length; // past the row, or its text spilling out of its own box
  // a destination's URL keeps a readable stretch next to a long scope tag (the tag is capped, the URL is what the person recognises)
  const urlNarrow = [...document.querySelectorAll('span.font-mono.truncate')].filter((u) => u.getBoundingClientRect().width < 80).length;
  const avatarButtons = [...document.querySelectorAll('button')].filter((b) => vis(b) && ['사진 변경', '제거'].includes((b.textContent || '').trim())).length;
  return { presses: presses.length, small, tiny, clipped, tagOut, urlNarrow, avatarButtons, switches: document.querySelectorAll('[role=switch]').length, overflowX: document.documentElement.scrollWidth > innerWidth + 1, oldSlots: [...document.querySelectorAll('[data-slot]')].map((e) => e.getAttribute('data-slot')!).filter((s) => !s.startsWith('ds-')) };
});

test.describe('on a touch phone (390 × 844)', () => {
  test.use({ hasTouch: true, isMobile: true });

  test('[SID:4891] every press in the destinations card and the blocked list is at least 44 × 44, and no text is under 12 px', async ({ page }) => {
    await open(page, 390, 844);
    const m = await measure(page);
    expect(m.avatarButtons, 'the photo card: change + remove').toBe(2);
    expect(m.switches, 'one on/off switch per destination').toBe(3);
    // reverted (the 20 px switch · the 28 px test/delete icons · the 28 px unblock · the 11 px tags) → the small list is not empty
    expect(m.small, `presses under 44 px: ${m.small.join(' · ')}`).toEqual([]);
    expect(m.tiny, `text under 12 px: ${m.tiny.join(' · ')}`).toEqual([]);
    expect(m.overflowX).toBe(false);
    expect(m.clipped, 'rows whose controls run past the row').toBe(0);
    expect(m.tagOut, 'a scope tag (the long project name) runs past its row').toBe(0);
    expect(m.urlNarrow, 'a destination URL squeezed under 80 px by a long scope tag').toBe(0);
    expect(m.oldSlots, 'old (non-ds) parts drawn').toEqual([]);
  });

  test('[SID:4891] the switch still flips the destination (PUT body is_active) and aria-checked follows the refetched list', async ({ page }) => {
    await open(page, 390, 844);
    const sw = page.locator('[role=switch][aria-checked=true]').first();
    const label = await sw.getAttribute('aria-label');
    await sw.tap();
    await expect.poll(() => putBody).not.toBeNull();
    // the whole row goes back, only is_active flipped (a dropped member_id / project_id would save a different row)
    const orig = origHooks.find((h) => h.url === putBody!.url)!;
    expect(putBody).toEqual({ member_id: 'm-me', url: orig.url, project_id: orig.project_id, is_active: false });
    await expect(page.locator(`[role=switch][aria-label="${label}"]`)).toHaveAttribute('aria-checked', 'false');
  });
});
