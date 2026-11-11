/**
 * story 4887 (UI-4 P4-c) — the chat cards, measured in Chromium with the REAL components (bundled with esbuild, not copied) and the real Tailwind build of globals.css; only the shell's answers are made up.
 * The rule: the approval card (the ds ApprovalCard), the server-command card and the command hint stay inside the screen, wrap long words instead of running past it, and — on a touch screen —
 * every action is at least 44 × 44 (the ds Button's own `touch:` floor); the approve button is the one primary action of its row.
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

const LONG_WORD = 'https://example.com/a-very-long-unbreakable-url-without-any-space-in-it-that-keeps-going/and/going/and/going?x=1&y=2';
const GATE = (o: object = {}) => ({
  id: 'g1', org_id: 'org-1', work_item_id: 'w-1', work_item_type: 'agent_decision', gate_type: 'agent_decision_request', status: 'pending', resolver_id: null, resolved_at: null, resolution_note: null,
  neutral_facts: { question: `배포를 지금 진행할까요? ${LONG_WORD}`, options: ['지금 진행', '내일 오전으로 미룸', `보류 — ${LONG_WORD}`], assumption: '롤백 계획은 이미 있습니다', requested_by_member_id: 'a-1' },
  created_at: '2026-11-10T01:00:00Z', updated_at: '2026-11-10T01:00:00Z', can_approve: true, risk_grade: 'low', designated_approver_id: 'me-1',
  work_item_summary: { title: `긴 제목의 결재 요청 — ${LONG_WORD}`, slug: null }, ...o,
});

let built: { js: string; css: string } | null = null;
async function build() {
  if (built) return built;
  const esbuild = req('esbuild') as typeof import('esbuild');
  const bodies: Record<string, string> = {
    '@/components/realtime-provider': 'export function useSseMultiplexerContext() { return { subscribe: () => () => {} }; }',
    '@/app/dashboard/dashboard-shell': "export function useDashboardContext() { return { orgId: 'org-1', currentTeamMemberId: 'me-1', projectId: 'p1', role: 'member', currentMemberType: 'human', projectMemberships: [] }; }",
  };
  const filter = new RegExp(`^(${Object.keys(bodies).map((k) => k.replace(/[/.-]/g, '\\$&')).join('|')})$`);
  const out = await esbuild.build({
    stdin: {
      contents: `
        import React from 'react'; import { createRoot } from 'react-dom/client'; import { NextIntlClientProvider } from 'next-intl';
        import ko from './messages/ko.json';
        import { ApprovalRequestCard } from './src/components/chat/approval-request-card';
        import { ServerCommandResultCard } from './src/components/chat/server-command-result-card';
        import { CommandHintNotice } from './src/components/chat/command-hint-notice';
        import { ToastProvider } from './src/components/ui/toast';
        window.__mount = (w) => {
          const h = React.createElement;
          createRoot(document.getElementById('root')).render(h(NextIntlClientProvider, { locale: 'ko', messages: ko, timeZone: 'Asia/Seoul' }, h(ToastProvider, null,
            h('div', { id: 'col', style: { width: w + 'px', padding: '0 12px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: '12px' } },
              h('div', { id: 'approval' }, h(ApprovalRequestCard, { target: { work_item_type: 'agent_decision', work_item_id: 'w-1', gate_id: 'g1', actions: ['approve', 'reject'] } })),
              h('div', { id: 'server' }, h(ServerCommandResultCard, { content: "'/assign' 실패 — 「채영」에 일치하는 멤버가 여럿입니다: 채영1, 채영2 " + ${JSON.stringify(LONG_WORD)}, serverCommand: { command: 'assign', outcome: 'ambiguous', candidates: ['채영1', '채영2 ${LONG_WORD.slice(0, 60)}'], target_story_number: 7 }, onFillComposer() {} })),
              h('div', { id: 'hint' }, h(CommandHintNotice, { hint: { agent_id: 'a-1', agent_name: '아주 긴 이름의 검수 에이전트', runtime_type: null, command: 'review', reason: 'unsupported' } }))))));
        };`,
      resolveDir: WEB, loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', jsx: 'automatic',
    tsconfig: path.join(WEB, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_APP_URL': '"https://app.sprintable.ai"' },
    plugins: [
      { name: 'cards-4887-stubs', setup(b) {
        b.onResolve({ filter }, (a) => ({ path: a.path, namespace: 'cards4887' }));
        b.onLoad({ filter: /.*/, namespace: 'cards4887' }, (a) => ({ contents: bodies[a.path]!, loader: 'js', resolveDir: WEB }));
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

async function open(page: Page, width: number, gate: object = GATE()) {
  const { js, css } = await build();
  await page.setViewportSize({ width: Math.max(width, 320), height: 900 });
  await page.unrouteAll();
  await page.route('http://preview.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-background text-foreground" style="margin:0"><div id="root"></div></body></html>` });
    }
    if (url.pathname === '/api/gates/g1') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(gate) });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [] }) });
  });
  await page.goto('about:blank');
  await page.goto('http://preview.test/');
  await page.addScriptTag({ content: js });
  await page.evaluate((w) => (window as unknown as { __mount: (w: number) => void }).__mount(w), width);
  await page.locator('[data-slot="ds-approval-card"] h3').waitFor();
  await page.waitForTimeout(300);
}

/** everything inside #col stays inside it; buttons report their size */
const measure = (page: Page) => page.evaluate(() => {
  const col = document.getElementById('col')!.getBoundingClientRect();
  const out: string[] = [];
  for (const el of document.querySelectorAll('#col *')) {
    const r = (el as HTMLElement).getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) continue; // a 1 × 1 off-screen control (sr-only) is not a visible part
    if (r.right > col.right + 0.5 || r.left < col.left - 0.5) out.push(`${el.tagName.toLowerCase()}${(el as HTMLElement).dataset.testid ? '[' + (el as HTMLElement).dataset.testid + ']' : ''} ${Math.round(r.left - col.left)}..${Math.round(r.right - col.left)}`);
  }
  const buttons = [...document.querySelectorAll('#col button, #col a[href]')].map((b) => { const r = (b as HTMLElement).getBoundingClientRect(); return { text: (b.textContent ?? '').trim().slice(0, 20), w: Math.round(r.width), h: Math.round(r.height) }; });
  return { outside: out, scroll: [document.documentElement.scrollWidth, document.documentElement.clientWidth], buttons };
});

for (const width of [390, 320]) {
  test.describe(`touch ${width}`, () => {
    test.use({ hasTouch: true, isMobile: true });
    test(`[SID:4887] the three cards stay inside the screen and every action is at least 44 × 44`, async ({ page }) => {
      await open(page, width);
      const m = await measure(page);
      expect(m.outside, `running past the column: ${m.outside.join(' | ')}`).toEqual([]);
      expect(m.scroll[0], 'no horizontal overflow').toBeLessThanOrEqual(m.scroll[1]);
      const small = m.buttons.filter((b) => b.h < 44 || b.w < 44);
      expect(small, `touch targets under 44: ${JSON.stringify(small)}`).toEqual([]); // reverted (a 28 px button on touch) → fails
    });
  });
}

test('[SID:4887] 1100 mouse: the three cards stay inside the column, approve is the one primary button of its row, the amber bar is on the card that needs a hand', async ({ page }) => {
  await open(page, 480);
  const m = await measure(page);
  expect(m.outside, `running past the column: ${m.outside.join(' | ')}`).toEqual([]);
  const bar = await page.evaluate(() => { const c = document.querySelector('[data-slot="ds-approval-card"]') as HTMLElement; return { tone: c.dataset.tone, left: getComputedStyle(c).borderLeftWidth }; });
  expect(bar.tone).toBe('needs-hand');
  expect(parseFloat(bar.left), 'the amber left bar is 4 px').toBeGreaterThanOrEqual(4);
  const prim = await page.evaluate(() => [...document.querySelectorAll('[data-slot="ds-approval-actions"] button')].map((b) => ({ t: (b.textContent ?? '').trim(), primary: /bg-ds-action/.test(b.className) })));
  expect(prim.find((b) => b.t === '승인')?.primary).toBe(true);
  expect(prim.find((b) => b.t === '반려')?.primary).toBe(false);
});

test('[SID:4887] a gate that passed by itself draws a neutral line (not the failed or done colour) at 320', async ({ page }) => {
  await open(page, 320, GATE({ status: 'auto_passed', neutral_facts: {} }));
  const c = await page.evaluate(() => {
    const line = document.querySelector('[data-resolution="auto_passed"]') as HTMLElement | null; if (!line) return null;
    const probe = (cls: string) => { const e = document.createElement('p'); e.className = cls; document.body.appendChild(e); const col = getComputedStyle(e).color; e.remove(); return col; };
    return { colour: getComputedStyle(line).color, neutral: probe('text-ds-ink-2'), failed: probe('text-ds-failed'), done: probe('text-ds-done') };
  });
  expect(c, 'the auto_passed line is drawn').not.toBeNull();
  expect(c!.colour).toBe(c!.neutral);
  expect(c!.colour).not.toBe(c!.failed);
  expect(c!.colour).not.toBe(c!.done);
});
