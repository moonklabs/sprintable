/**
 * story 4887 (UI-4 · the whole conversation screen on the approved layout B3) — the four regions that differed from the approved mockup, measured together in Chromium at a 1100 px window (the Mac app size):
 * the REAL ChatListView · RoomHead · ChatBubble · ChatInput · ThreadPanel (bundled with esbuild, not copied) side by side in the real column widths, with the real Tailwind build of globals.css; only the shell's answers are made up.
 * The rule per region: ① the list head is ONE line (the project card, the filter and the tabs are not above the rooms) ② the room head is name · tag · one line · a chip row — and no button but «back» (phone) · «+» · «⋯» ③ the composer is ONE bordered box with the clip, the text and «⏎ 보내기» inside
 * ④ the thread head is ONE line with the original message right under it, the replies plain rows. Dark and light.
 */
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { compile, optimize } from '@tailwindcss/node';
import { layoutStubPlugin } from './support/layout-stubs';

const req = createRequire(__filename);
const WEB = path.join(__dirname, '..');
const APP = path.join(WEB, 'src', 'app');

const ME = { member_id: 'me-1', name: '지우', type: 'human' };
const DEV = { member_id: 'a-1', name: '개발 에이전트', type: 'agent', runtime_type: 'claude-code', device_name: 'SYJ-Mac' };
const REVIEW = { member_id: 'a-2', name: '검수 에이전트', type: 'agent', runtime_type: 'claude-code', device_name: 'SYJ-Mac' };
const MINSEO = { member_id: 'h-2', name: '민서', type: 'human' };
const row = (id: string, type: 'dm' | 'group', title: string | null, participants: object[], at: string, preview: string, unread = 0, project: string | null = 'AC4 project') => ({
  id, type, title, participants, latest_message: { content: preview, created_at: at }, updated_at: at, unread_count: unread, project_id: project ? 'p1' : null, project_name: project,
});
const CONVERSATIONS = [
  row('c1', 'group', '결제 연동 · 오늘 할 일', [ME, DEV, REVIEW, MINSEO], '2026-11-11T05:00:00Z', '@나 고객 문의 3건 답변 초안이 준비됐어요', 3),
  row('c2', 'group', '랜딩 문구 검토', [ME, MINSEO], '2026-11-11T04:12:00Z', '지우 · 둘째 문단만 바꿔 볼게요', 1),
  row('c3', 'dm', null, [ME, DEV], '2026-11-11T03:50:00Z', '회원가입 오류 · 원인 찾았어요', 0, null),
  row('c4', 'dm', null, [ME, MINSEO], '2026-11-10T09:00:00Z', '좋은 아침이에요', 0, null),
  row('c5', 'group', '주간 고객 문의', [ME, MINSEO], '2026-11-10T08:00:00Z', '첨부 파일', 0),
];
const msg = (o: object) => ({ conversation_id: 'c1', attachments: [], created_at: '2026-11-11T00:30:00Z', ...o });
const MESSAGES = [
  msg({ id: 'm1', created_by: 'me-1', sender_name: '지우', sender_type: 'human', content: '좋은 아침이에요. 오늘 출시 체크리스트부터 볼게요.', created_at: '2026-11-11T00:30:00Z' }),
  msg({ id: 'm2', created_by: 'a-1', sender_name: '개발 에이전트', sender_type: 'agent', sender_runtime_type: 'claude-code', content: '결제 연동 점검을 끝냈어요. 실패한 요청은 0건이에요. 상세 로그는 첨부 문서에 있어요.', created_at: '2026-11-11T00:35:00Z' }),
  msg({ id: 'm3', created_by: 'a-1', sender_name: '개발 에이전트', sender_type: 'agent', sender_runtime_type: 'claude-code', content: '결재 요청', approval_target: { work_item_type: 'story', work_item_id: 'w-1', gate_id: 'g1', actions: ['approve', 'reject'] }, reply_count: 3, created_at: '2026-11-11T00:43:00Z' }),
  msg({ id: 'm4', created_by: 'me-1', sender_name: '지우', sender_type: 'human', content: '/review #12', created_at: '2026-11-11T00:44:00Z' }),
];
const REPLIES = [
  msg({ id: 'r1', parent_id: 'm3', created_by: 'h-1', sender_name: '지우', sender_type: 'human', content: '전제만 다시 확인할게요.', created_at: '2026-11-11T00:45:00Z' }),
  msg({ id: 'r2', parent_id: 'm3', created_by: 'a-2', sender_name: '검수 에이전트', sender_type: 'agent', sender_runtime_type: 'claude-code', content: '시험 14/14 통과 그대로예요.', created_at: '2026-11-11T00:46:00Z' }),
  msg({ id: 'r3', parent_id: 'm3', created_by: 'h-2', sender_name: '민서', sender_type: 'human', content: '저도 확인했어요.', created_at: '2026-11-11T00:48:00Z' }),
];
const GATE = {
  id: 'g1', org_id: 'org-1', work_item_id: 'w-1', work_item_type: 'agent_decision', gate_type: 'agent_decision_request', status: 'pending', resolver_id: null, resolved_at: null, resolution_note: null,
  neutral_facts: { question: '무엇을 승인하나 — 결제 수단 두 개 추가', options: [], assumption: '승인 뒤에도 되돌릴 수 있어요', requested_by_member_id: 'a-1' },
  created_at: '2026-11-11T00:43:00Z', updated_at: '2026-11-11T00:43:00Z', can_approve: true, risk_grade: 'low', designated_approver_id: 'me-1', work_item_summary: { title: '결제 수단 두 개 추가', slug: null },
};

let built: { js: string; css: string } | null = null;
async function build() {
  if (built) return built;
  const esbuild = req('esbuild') as typeof import('esbuild');
  const bodies: Record<string, string> = {
    '@/components/realtime-provider': 'export function useSseMultiplexerContext() { return { isAlive: () => false, subscribe: () => () => {}, subscribeMessage: () => () => {}, subscribeReconnect: () => () => {}, connected: true }; }',
    '@/hooks/use-chat-sse': 'export function useChatSse() { return { connected: true, polling: false }; } export const isOwnMessage = () => false; export function newClientNonce() { return "n"; } export function normalizeToMessage(m) { return m; } export function sentMessageFromAnswer(m) { return m; }',
    '@/hooks/use-auto-refresh': 'export function useAutoRefresh() {}',
    '@/app/dashboard/dashboard-shell': "export function useDashboardContext() { return { orgId: 'org-1', currentTeamMemberId: 'me-1', projectId: 'p1', role: 'member', currentMemberType: 'human', orgMemberships: [], projectMemberships: [{ projectId: 'p1', projectName: 'AC4 project' }, { projectId: 'p2', projectName: '랜딩' }] }; }",
    'next/navigation': "export function useRouter() { return { push() {}, replace() {}, back() {}, refresh() {}, prefetch() {} }; } export function useSearchParams() { return new URLSearchParams(''); } export function usePathname() { return '/chats'; } export function useParams() { return {}; }",
  };
  const filter = new RegExp(`^(${Object.keys(bodies).map((k) => k.replace(/[/.-]/g, '\\$&')).join('|')})$`);
  const out = await esbuild.build({
    stdin: {
      contents: `
        import React from 'react'; import { createRoot } from 'react-dom/client'; import { NextIntlClientProvider } from 'next-intl';
        import ko from './messages/ko.json';
        import { ChatListView } from './src/components/chat/chat-list-view';
        import { RoomHead } from './src/components/chat/room-head';
        import { ChatBubble } from './src/components/chat/chat-bubble';
        import { ChatInput } from './src/components/chat/chat-input';
        import { ThreadPanel } from './src/components/chat/thread-panel';
        import { StatusLabel } from './src/components/ds/status-label';
        import { Avatar } from './src/components/shared/avatar';
        import { ToastProvider } from './src/components/ui/toast';
        const MESSAGES = ${JSON.stringify(MESSAGES)};
        const PARENT = MESSAGES[2];
        const chip = (p, status) => ({ id: p.member_id, who: <><Avatar name={p.name} label={p.name} avatarUrl={null} actorType={p.type === 'agent' ? 'agent' : 'human'} size={18} className="flex-shrink-0" runtimeType={p.type === 'agent' ? 'claude-code' : null} /><span className="min-w-0 truncate">{p.name}{p.member_id === 'me-1' ? '(나)' : ''}</span></>, state: status ? <StatusLabel status={status} label={{ online: '연결됨', idle: '자리 비움', offline: '끊김' }[status]} /> : undefined });
        window.__mount = () => {
          createRoot(document.getElementById('root')).render(
            <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul"><ToastProvider>
              <div id="screen" style={{ display: 'flex', width: '1028px', height: '760px' }} className="bg-background text-foreground">
                <div id="rail" className="flex min-h-0 w-[248px] shrink-0 flex-col overflow-hidden border-r border-border"><ChatListView projectId="p1" currentTeamMemberId="me-1" canStartRoom /></div>
                <div id="room" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                  <RoomHead title="결제 연동 · 오늘 할 일" tag="프로젝트 방" subline="AC4 project · 4명" chips={[chip({ member_id: 'me-1', name: '지우', type: 'human' }), chip({ member_id: 'a-1', name: '개발 에이전트', type: 'agent' }, 'online'), chip({ member_id: 'a-2', name: '검수 에이전트', type: 'agent' }, 'idle'), chip({ member_id: 'h-2', name: '민서', type: 'human' })]} addLabel="참여자 추가" onAdd={() => {}} trailing={<button type="button" aria-label="방 더보기">⋯</button>} />
                  <div id="timeline" className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{MESSAGES.map((m, i) => <ChatBubble key={m.id} message={m} isMine={m.created_by === 'me-1'} isGrouped={false} onOpenThread={() => {}} />)}</div>
                  <ChatInput threadId="c1" onSend={async () => {}} onUploadFile={async (f) => ({ url: 'u', name: f.name, content_type: f.type, size: f.size })} projectId="p1" currentTeamMemberId="me-1" participants={[{ member_id: 'a-1', name: '개발 에이전트' }]} placeholder={ko.chats.inputPlaceholderFull} />
                </div>
                <div id="thread" className="flex min-h-0 w-[300px] shrink-0 flex-col overflow-hidden"><ThreadPanel parentMessage={PARENT} conversationId="c1" currentTeamMemberId="me-1" projectId="p1" onClose={() => {}} /></div>
              </div>
            </ToastProvider></NextIntlClientProvider>);
        };`,
      resolveDir: WEB, loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', jsx: 'automatic',
    tsconfig: path.join(WEB, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_APP_URL': '"https://app.sprintable.ai"' },
    plugins: [
      { name: 'screen-4887-stubs', setup(b) {
        b.onResolve({ filter }, (a) => ({ path: a.path, namespace: 'screen4887' }));
        b.onLoad({ filter: /.*/, namespace: 'screen4887' }, (a) => ({ contents: bodies[a.path]!, loader: 'js', resolveDir: WEB }));
        b.onResolve({ filter: /^\.\/(now-strip|pulse-card)$/ }, (a) => ({ path: a.path, namespace: 'strip4887' }));
        b.onLoad({ filter: /.*/, namespace: 'strip4887' }, (a) => ({ contents: a.path.includes('now-strip') ? 'export function NowStrip() { return null; }' : 'export function PulseCard() { return null; }', loader: 'js', resolveDir: WEB }));
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

async function open(page: Page, scheme: 'light' | 'dark') {
  const { js, css } = await build();
  await page.emulateMedia({ colorScheme: scheme });
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.unrouteAll();
  await page.route('http://preview.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="ko" class="${scheme === 'dark' ? 'dark' : ''}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-background text-foreground" style="margin:0"><div id="root"></div></body></html>` });
    }
    const json = (b: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(b) });
    if (url.pathname === '/api/conversations') return json({ data: CONVERSATIONS, total: CONVERSATIONS.length });
    if (url.pathname.startsWith('/api/conversations/recent-outside-project')) return json({ data: [] });
    if (url.pathname.endsWith('/messages')) return json({ data: REPLIES });
    if (url.pathname === '/api/gates/g1') return json(GATE);
    return json({ data: [] });
  });
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 400)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 400)); });
  await page.goto('about:blank');
  await page.goto('http://preview.test/');
  await page.addScriptTag({ content: js });
  await page.evaluate(() => (window as unknown as { __mount: () => void }).__mount());
  try {
    await page.locator('[data-testid="chat-list-head"]').waitFor({ timeout: 8000 });
    await page.locator('[data-slot="ds-approval-card"]').first().waitFor({ timeout: 8000 });
  } catch (e) { throw new Error(`the screen did not mount: ${errs.join(' | ') || String(e).slice(0, 200)}`); }
  await page.waitForTimeout(500);
}

const box = (page: Page, sel: string) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; }, sel);

for (const scheme of ['light', 'dark'] as const) {
  test.describe(scheme, () => {
    test(`[SID:4887] ${scheme} 1100: the four regions are on the approved layout`, async ({ page }) => {
      await open(page, scheme);
      if (process.env.SCREEN_SHOTS) { mkdirSync(process.env.SCREEN_SHOTS, { recursive: true }); await page.screenshot({ path: path.join(process.env.SCREEN_SHOTS, `screen-after-${scheme}__1100.png`) }); }

      // ① the list head is ONE line, and the first room starts right under it (nothing above the rooms)
      const lh = (await box(page, '[data-testid="chat-list-head"]'))!;
      const firstRoom = (await box(page, '[data-testid="chat-list-rooms"] button'))!;
      expect(lh.h, `the list head is ${lh.h}px`).toBeLessThanOrEqual(48); // reverted (the strips + filter + tabs above the rooms) → far taller
      expect(firstRoom.y - (lh.y + lh.h), 'the first room starts under the head').toBeLessThanOrEqual(12);
      expect(await page.locator('[data-testid="chat-list-head"]').textContent(), 'the head reads «대화 N» and carries its two buttons').toContain('대화');
      expect(await page.locator('#rail select, #rail [role="tab"]').count(), 'no filter select and no tabs above the rooms').toBe(0);
      expect(await page.locator('#rail').getByText('DM', { exact: true }).count(), 'no «DM» / «그룹» sub-heads').toBe(0);

      // the moved controls are REACHABLE: «⋯» opens a named popover that holds the project filter (portal) — and the whole thing stays on the screen
      await page.locator('[data-testid="chat-list-options"]').click();
      const popup = page.locator('[role="dialog"][aria-label="목록 설정"]');
      await expect(popup).toBeVisible(); // reverted (the popover has no name) → not found
      await expect(popup.locator('[data-testid="project-filter"]')).toBeVisible();
      const pb = (await popup.boundingBox())!;
      expect(pb.x >= 0 && pb.x + pb.width <= 1100, `the popover is on the screen (x ${Math.round(pb.x)}..${Math.round(pb.x + pb.width)})`).toBe(true);
      await page.keyboard.press('Escape');
      await expect(popup).toHaveCount(0);
      expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute('data-testid')), 'focus returns to the «⋯» that opened it').toBe('chat-list-options');

      // ② the room head: name · tag · one line · a chip row; its buttons are only the «+» (the «⋯» here is the harness's trailing slot)
      const head = page.locator('[data-testid="room-head"]');
      await expect(head.locator('h1')).toHaveText('결제 연동 · 오늘 할 일');
      await expect(head.locator('[data-testid="room-head-tag"]')).toHaveText('프로젝트 방');
      await expect(head.locator('[data-testid="room-head-subline"]')).toContainText('4명');
      expect(await head.locator('[data-testid="room-head-chip"]').count()).toBe(4);
      expect(await head.locator('[data-slot="ds-status-label"]').count(), 'the two agents carry a connection word, the two people do not').toBe(2);
      const hb = (await box(page, '[data-testid="room-head"]'))!;
      expect(hb.h, `the room head is ${hb.h}px`).toBeLessThanOrEqual(140); // name + one line + at most two chip rows at this width (a thread is open beside it)

      // ③ the composer is ONE bordered box holding the clip, the text and «⏎ 보내기»
      const cb = (await box(page, '[data-testid="chat-composer-box"]'))!;
      const inside = await page.evaluate(() => { const bx = document.querySelector('[data-testid="chat-composer-box"]')!.getBoundingClientRect(); const ok = (s: string) => { const e = document.querySelector(s); if (!e) return false; const r = e.getBoundingClientRect(); return r.left >= bx.left - 0.5 && r.right <= bx.right + 0.5 && r.top >= bx.top - 0.5 && r.bottom <= bx.bottom + 0.5; }; return { clip: ok('[data-testid="chat-attach-upload"]'), text: ok('#room textarea'), send: ok('#room [data-testid="chat-send"]') }; });
      expect(inside, 'clip · text · send are inside the one box').toEqual({ clip: true, text: true, send: true });
      expect(cb.h, `the composer box is ${cb.h}px`).toBeLessThanOrEqual(64);
      const face = await page.evaluate(() => { const e = document.querySelector('[data-testid="chat-composer-box"]') as HTMLElement; const cs = getComputedStyle(e); const sb = (document.querySelector('#room [data-testid="chat-send"]') as HTMLElement).getBoundingClientRect(); return { border: parseFloat(cs.borderTopWidth), bg: cs.backgroundColor, page: getComputedStyle(document.body).backgroundColor, sendW: Math.round(sb.width) }; });
      expect(face.border, 'the box has a visible border').toBeGreaterThanOrEqual(1); // reverted (a borderless row) → 0
      expect(face.bg, 'and its own face').not.toBe(face.page);
      expect(face.sendW, `«⏎ 보내기» is a words button at 1100 (${face.sendW}px), not a bare icon`).toBeGreaterThanOrEqual(70);
      // the REAL hint ChatView passes at desktop widths (this scene once used the short phone hint, and the long one wrapped and was cut off in the real 480 px room column): it must fit on ONE line, whole
      const hint = await page.evaluate(() => { const ta = document.querySelector('#room textarea') as HTMLTextAreaElement; const cs = getComputedStyle(ta); const c = document.createElement('canvas').getContext('2d')!; c.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`; const avail = ta.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight); const plc = getComputedStyle(ta, '::placeholder'); return { text: ta.placeholder, need: Math.ceil(c.measureText(ta.placeholder).width), avail: Math.round(avail), nowrap: plc.whiteSpace }; });
      expect(hint.text).toBe('메시지 쓰기 — / 명령 · @ 멘션 · # 엔티티');
      expect(hint.need, `the hint needs ${hint.need}px of the ${hint.avail}px the text area has`).toBeLessThanOrEqual(hint.avail); // reverted (the old long hint, ~40 characters) → wider than the box: wraps and is cut
      expect(hint.nowrap, 'and it can never wrap into a second (clipped) line').toBe('nowrap');
      expect(await page.locator('#room [data-testid="chat-send"]').textContent()).toContain('보내기');

      // ④ the thread head is ONE line; the original message is right under it; the replies are plain rows
      const th = (await box(page, '[data-testid="thread-head"]'))!;
      const orig = (await box(page, '[data-testid="thread-original"]'))!;
      expect(th.h, `the thread head is ${th.h}px`).toBeLessThanOrEqual(48);
      expect(orig.y - (th.y + th.h), 'the original sits right under the head').toBeLessThanOrEqual(2);
      await expect(page.locator('[data-testid="thread-meta"]')).toHaveText('결재 요청 · 3개의 답글');
      const bubbles = await page.evaluate(() => [...document.querySelectorAll('[data-testid="thread-replies"] [data-testid="chat-bubble-text"]')].map((e) => e.getAttribute('data-bubble')));
      expect(bubbles).toEqual(['plain', 'plain', 'plain']);

      // the cards: the approval card is the ds ApprovalCard with the amber bar and ONE primary action
      const card = await page.evaluate(() => { const c = document.querySelector('#timeline [data-slot="ds-approval-card"]') as HTMLElement | null; return c ? { tone: c.dataset.tone } : null; });
      expect(card?.tone).toBe('needs-hand');

      // nothing runs past the screen
      const over = await page.evaluate(() => ({ s: document.getElementById('screen')!.scrollWidth, c: document.getElementById('screen')!.clientWidth }));
      expect(over.s).toBeLessThanOrEqual(over.c);
    });
  });
}
