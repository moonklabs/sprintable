import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { compile, optimize } from '@tailwindcss/node';
import { layoutStubPlugin } from './support/layout-stubs';
import { tailwindCandidates } from './support/tailwind-candidates';

const req = createRequire(__filename);
const WEB = path.join(__dirname, '..');
const APP = path.join(WEB, 'src', 'app');

let built: { js: string; css: string } | null = null;
async function build() {
  if (built) return built;
  const esbuild = req('esbuild') as typeof import('esbuild');
  const out = await esbuild.build({
    stdin: {
      contents: `
        import React from 'react'; import { createRoot } from 'react-dom/client'; import { NextIntlClientProvider } from 'next-intl';
        import ko from './messages/ko.json';
        import { ChatBubble } from './src/components/chat/chat-bubble';
        const base = { memo_id: 'c1', attachments: [], created_at: '2026-11-14T03:16:00.000Z', sender_avatar_url: null, sender_runtime_type: null };
        const STEER = { blocks: [{ type: 'header', text: '{{t.steerHeader}}' }, { type: 'text', text: '{{payload.instruction}}' }, { type: 'fields', fields: [{ label: '{{t.steerTargetLabel}}', value: '{{label.target_name}}', optional: true }] }] };
        const MESSAGES = [
          { ...base, id: 'm1', created_by: 'sys', sender_name: '시스템', sender_type: 'agent', content: '[이벤트] preset.steer.instruct\\n- instruction: 방향 지시 카드 — 비교용', event: { event_key: 'preset.steer.instruct', payload: { instruction: '방향 지시 카드 — 비교용', target_member_id: 't-1' }, refs: { target: { found: true, name: 'Dan Repro B' } } } },
          { ...base, id: 'm2', created_by: 'sys', sender_name: '시스템', sender_type: 'agent', content: '[이벤트] org.acme.deploy_checked\\n- note: 템플릿 없는 이벤트 — 비교용', event: { event_key: 'org.acme.deploy_checked', payload: { note: '템플릿 없는 이벤트 — 비교용', build_number: 42, environment: 'dev' }, refs: {} } },
          { ...base, id: 'm3', created_by: 'h-1', sender_name: '지우', sender_type: 'human', content: '사람이 쓴 말 — 말풍선' },
        ];
        const DEFS = { 'preset.steer.instruct': { name: '방향 전환', block_template: STEER }, 'org.acme.deploy_checked': { name: '배포 확인', block_template: null } };
        window.__mount = () => {
          createRoot(document.getElementById('root')).render(React.createElement(NextIntlClientProvider, { locale: 'ko', messages: ko, timeZone: 'Asia/Seoul' },
            React.createElement('div', { style: { padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }, className: 'bg-ds-background' },
              ...MESSAGES.map((m) => React.createElement('div', { id: m.id, key: m.id }, React.createElement(ChatBubble, { message: m, isMine: false, isGrouped: false, eventDefinitionsByKey: DEFS }))),
              React.createElement('div', { id: 'probe', className: 'rounded-ds-control border border-ds-line bg-ds-surface px-3.5 py-3' }, 'ds Card family'))));
        };`,
      resolveDir: WEB, loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', jsx: 'automatic',
    tsconfig: path.join(WEB, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_APP_URL': '"https://app.sprintable.ai"' },
    plugins: [layoutStubPlugin()],
  });
  const js = out.outputFiles[0]!.text;
    const candidates = tailwindCandidates(js);
  const compiler = await compile(readFileSync(path.join(APP, 'globals.css'), 'utf8'), { base: APP, onDependency: () => {} });
  const css = (optimize as unknown as (c: string, o?: object) => { code: string })(compiler.build(candidates), { minify: false }).code;
  built = { js, css };
  return built;
}


let dark = false;
async function open(page: Page, width: number, isDark: boolean) {
  dark = isDark;
  const { js, css } = await build();
  await page.setViewportSize({ width, height: 844 });
  await page.unrouteAll();
  await page.route('http://preview.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="ko" class="${dark ? 'dark' : ''}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body style="margin:0" class="bg-ds-background"><div id="root"></div></body></html>` });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [] }) });
  });
  await page.goto('about:blank'); await page.goto('http://preview.test/');
  await page.addScriptTag({ content: js });
  await page.evaluate(() => (window as unknown as { __mount: () => void }).__mount());
  await page.locator('#probe').waitFor();
  await page.locator('#m2 [data-event-card="text"]').waitFor();
}

const SHELL_PROPS = ['backgroundColor', 'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'] as const;
async function shells(page: Page) {
  return page.evaluate((props) => {
    const pick = (el: Element | null) => { if (!el) return null; const cs = getComputedStyle(el); return Object.fromEntries(props.map((p) => [p, (cs as unknown as Record<string, string>)[p]])); };
    return {
      card: pick(document.querySelector('#m1 .rounded-tl-sm.border-ds-line')),
      textEvent: pick(document.querySelector('#m2 [data-event-card="text"]')),
      person: pick(document.querySelector('#m3 [data-testid="chat-bubble-text"]')),
      probe: pick(document.querySelector('#probe')),
      textEventHead: document.querySelector('#m2 [data-event-card="text"] p')?.textContent ?? null,
      cardHeadType: (() => { const e = document.querySelector('#m1 .rounded-tl-sm.border-ds-line p'); if (!e) return null; const cs = getComputedStyle(e); return { fontSize: cs.fontSize, fontWeight: cs.fontWeight, lineHeight: cs.lineHeight, color: cs.color, overflowWrap: cs.overflowWrap }; })(),
      textEventHeadType: (() => { const e = document.querySelector('#m2 [data-event-card="text"] p'); if (!e) return null; const cs = getComputedStyle(e); return { fontSize: cs.fontSize, fontWeight: cs.fontWeight, lineHeight: cs.lineHeight, color: cs.color, overflowWrap: cs.overflowWrap }; })(),
      cardHead: document.querySelector('#m1 .rounded-tl-sm.border-ds-line')?.textContent ?? '',
    };
  }, SHELL_PROPS as unknown as string[]);
}

for (const [width, isDark] of [[1440, false], [1440, true], [390, false], [390, true]] as const) {
  test(`[SID:4906] ${width} ${isDark ? 'dark' : 'light'}: the template card and the template-less event are ONE shell (face · line · corners · padding), the same as the ds Card family; a person's bubble keeps its own`, async ({ page }) => {
    await open(page, width, isDark);
    const s = await shells(page);
    expect(s.card, 'the template card is drawn').not.toBeNull();
    expect(s.cardHead, 'it is the steer card').toContain('방향 전환');
    expect(s.textEventHead, 'the template-less event is drawn as text (head = the definition name)').toBe('배포 확인');
    expect(s.textEvent, 'the template-less event has the SAME shell as the template card — every value').toEqual(s.card);
    expect(s.card!['backgroundColor'], 'the face is the ds panel layer (the ds Card family)').toBe(s.probe!['backgroundColor']);
    expect(s.card!['borderTopColor'], 'the line is the ds hairline').toBe(s.probe!['borderTopColor']);
    expect(s.card!['borderTopWidth']).toBe('1px');
    expect(s.textEventHeadType, 'the template-less event\'s head is set like the template card\'s header (size · weight · line height · colour)').toEqual(s.cardHeadType);
    expect(s.cardHeadType!.fontWeight, 'a semibold head').toBe('600');
    expect(s.cardHeadType!.overflowWrap, 'a long unbroken name wraps instead of running past the card').toBe('anywhere');
    expect(s.person!['backgroundColor'], 'what a PERSON wrote keeps its bubble: another face than the card').not.toBe(s.card!['backgroundColor']);
    expect(s.person!['borderTopWidth'], 'and no line').toBe('0px');
  });
}
