// @vitest-environment jsdom
//
// story #4427 — 웹 설정 페이지: 기본값이 채워진 채 열림 · «시작» 한 번 = confirm 하나 · 실패 갈래 · 코드 없이 온 경우.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const { ctx, sp } = vi.hoisted(() => ({ ctx: vi.fn(), sp: { value: null as URLSearchParams | null } }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ctx() }));
// the query the router reports (the dashboard shell adds ?p= with a router replace)
vi.mock('next/navigation', async (orig) => ({ ...(await orig<typeof import('next/navigation')>()), useSearchParams: () => sp.value }));

import { DesktopSetup, DesktopSetupEntry, OpenInDesktopApp, SETUP_APP_LINK, ToolsNotConnected, failureForCode } from './desktop-setup';
import { DesktopSetupDocWatch } from './desktop-setup-doc-watch';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CODE = `${'A'.repeat(20)}_-${'b'.repeat(21)}`;
// what GET /api/desktop/recipes answers (4831): startable recipes only, each with the server's rows in flow order
const RECIPES: { id: string; key: string; name: string; description?: string; roles: { role: string; kind: 'human' | 'agent' | 'either'; stages: string[] }[] }[] = [
  {
    id: 'rec-1', key: 'org.marketing_loop', name: '마케팅 루프', description: '글감을 모으고 초안을 써요',
    roles: [{ role: '조사', kind: 'agent', stages: ['research'] }, { role: '작성', kind: 'either', stages: ['draft'] }, { role: '연출', kind: 'human', stages: ['review'] }],
  },
  { id: 'rec-2', key: 'org.research_one', name: '조사 한 명', roles: [{ role: '조사', kind: 'agent', stages: ['research'] }] },
];

let container: HTMLDivElement;
let root: Root;
let calls: { url: string; body?: unknown }[];
/** What GET /api/desktop/recipes answers now (tests change it: empty · failing · a list). */
let recipesNow: () => Response = () => new Response(JSON.stringify({ recipes: RECIPES }), { status: 200 });
/** What GET /api/desktop/setups/{id} answers now (the progress tests change it between polls). */
let statusNow: () => unknown = () => ({});

function stub(confirm: () => Response | Promise<Response>) {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith('/api/desktop/recipes')) return recipesNow();
    if (url.includes('/api/desktop/setup-codes/')) return confirm();
    if (url.includes('/api/desktop/setups/')) return new Response(JSON.stringify(statusNow()), { status: 200 });
    return new Response('{}', { status: 404 });
  }));
}

async function mount(node: React.ReactNode, role = 'owner') {
  ctx.mockReturnValue({ projectId: 'p-1', currentProjectSlug: 'proj', userName: '김지우', orgId: 'o-1', orgMemberships: [{ orgId: 'o-1', orgName: 'O', orgSlug: 'o', role }] });
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>); });
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
}
const text = () => container.textContent ?? '';
/** Change the address `#` and wait for the page's own `hashchange` handling (listeners run in the order they were added,
 * so the page's handler has run when this one does) — no sleeping. */
const setHash = async (h: string) => {
  await act(async () => {
    const fired = new Promise<void>((r) => window.addEventListener('hashchange', () => r(), { once: true }));
    window.location.hash = h;
    await fired;
  });
};
const startButton = () => [...container.querySelectorAll('button')].find((b) => b.textContent === '시작') as HTMLButtonElement;

beforeEach(() => { recipesNow = () => new Response(JSON.stringify({ recipes: RECIPES }), { status: 200 }); container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); sessionStorage.clear(); });
const events = () => calls.filter((c) => c.url.endsWith('/api/onboarding/events')).map((c) => c.body as { event: string; session_id: string });

describe('[SID:4427] desktop setup page', () => {
  it('opens with defaults: first recipe · human role «나 · 이름» · agent roles on the first runtime · folder ~/Sprintable/{recipe}', async () => {
    stub(() => new Response('{}', { status: 200 }));
    await mount(<DesktopSetup code={CODE} runtimes={['claude', 'codex']} />);
    expect((container.querySelector('input[name=recipe]:checked') as HTMLInputElement).value).toBe('rec-1');
    expect(text()).toContain('나 · 김지우');
    const selects = [...container.querySelectorAll('select')] as HTMLSelectElement[];
    expect(selects.map((s) => s.value)).toEqual(['claude', 'claude']); // 조사 · 작성(either)
    expect(text()).toContain('~/Sprintable/마케팅 루프');
    expect(text()).toContain('에이전트 2개를 이 컴퓨터에 만들고 첫 일감을 맡겨요 · 연출은 내가 맡아요');
    // PO 00:41Z · Yuna v17: right after the «시작» line, same muted size
    const notes = [...container.querySelectorAll('footer p')].map((p) => p.textContent);
    expect(notes[1]).toBe('에이전트는 Sprintable 안의 일은 묻지 않고 하고, 이 컴퓨터의 파일을 바꾸거나 명령을 실행하거나 다른 도구를 쓸 땐 그때마다 물어봐요.');
    expect(text()).not.toContain('발행'); // channel stage → later
    expect(startButton().disabled).toBe(false);
  });

  it('«시작» = one confirm with {role, runtime} for agent rows and the folder hint — nothing else is called', async () => {
    stub(() => new Response(JSON.stringify({ data: { work_item_id: 'w-1' } }), { status: 200 }));
    await mount(<DesktopSetup code={CODE} runtimes={['claude', 'codex']} />);
    await act(async () => { startButton().click(); });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    const posts = calls.filter((c) => c.body !== undefined);
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toContain('/api/desktop/setup-codes/confirm');
    expect(posts[0].url).not.toContain(CODE); // the code rides in the body only
    expect(posts[0].body).toEqual({ code: CODE, project_id: 'p-1', recipe_id: 'rec-1', roles: [{ role: '조사', runtime: 'claude' }, { role: '작성', runtime: 'claude' }], workdir_hint: '~/Sprintable/마케팅 루프' });
    expect(text()).toContain('에이전트를 시작하고 있어요');
  });

  it('only one runtime found → text, no picker, for an agent-only role', async () => {
    stub(() => new Response('{}'));
    await mount(<DesktopSetup code={CODE} runtimes={['codex']} />);
    expect(text()).toContain('Codex · 이 컴퓨터에 있음');
  });

  it('failures: nothing found ① · not an org admin ② · expired ④ · offline ⑤ — each with its one action', async () => {
    stub(() => new Response('{}'));
    await mount(<DesktopSetup code={CODE} runtimes={[]} />);
    expect(text()).toContain('이 컴퓨터에서 에이전트를 찾지 못했어요');
    expect(text()).toContain('curl -fsSL https://claude.ai/install.sh | bash');
    expect(text()).toContain('curl -fsSL https://chatgpt.com/codex/install.sh | sh');
    expect(text()).not.toContain('npm install');
    expect((container.querySelector(`a[href="${SETUP_APP_LINK}"]`) as HTMLAnchorElement).textContent).toBe('다시 찾기');
    await act(async () => { root.unmount(); }); root = createRoot(container);

    stub(() => new Response('{}'));
    await mount(<DesktopSetup code={CODE} runtimes={['claude']} />, 'member');
    expect(text()).toContain('에이전트를 만들려면 조직 관리자여야 해요');
    await act(async () => { root.unmount(); }); root = createRoot(container);

    stub(() => new Response(JSON.stringify({ error: { code: 'code_expired', message: 'x' } }), { status: 410 }));
    await mount(<DesktopSetup code={CODE} runtimes={['claude']} />);
    await act(async () => { startButton().click(); });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    expect(text()).toContain('설정 시간이 지났어요');
    expect((container.querySelector(`a[href="${SETUP_APP_LINK}"]`) as HTMLAnchorElement).textContent).toBe('앱에서 다시 시작');
    await act(async () => { root.unmount(); }); root = createRoot(container);

    stub(() => { throw new TypeError('fetch failed'); });
    await mount(<DesktopSetup code={CODE} runtimes={['claude']} />);
    await act(async () => { startButton().click(); });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    expect(text()).toContain('연결이 끊겼어요');
  });

  it('confirm codes → screens (closed list); an unknown code is not guessed', () => {
    expect(failureForCode('not_org_admin')).toBe('not-admin');
    expect(failureForCode('person_session_required')).toBe('not-admin');
    expect(failureForCode('code_used')).toBe('expired');
    expect(failureForCode('roles_invalid')).toBeNull();
    expect(failureForCode('PLAN_LIMIT_EXCEEDED', 'agent')).toBe('agent-limit');
    expect(failureForCode('PLAN_LIMIT_EXCEEDED', 'storage')).toBeNull();
    expect(failureForCode(undefined)).toBeNull();
  });

  it('empty or «~» folder blocks «시작»', async () => {
    stub(() => new Response('{}'));
    await mount(<DesktopSetup code={CODE} runtimes={['claude']} />);
    await act(async () => { ([...container.querySelectorAll('button')].find((b) => b.textContent === '바꾸기') as HTMLButtonElement).click(); });
    const input = container.querySelector('input:not([type=radio])') as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setValue.call(input, '~'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(startButton().disabled).toBe(true);
    expect(text()).toContain('홈 폴더 안의 한 폴더를 적어 주세요');
  });

  it('⑥(가) Claude blocked: Codex takes the roles, the blocked choice is only a turned-off option, one note line', async () => {
    stub(() => new Response(JSON.stringify({ data: {} }), { status: 200 }));
    await mount(<DesktopSetup code={CODE} runtimes={['claude', 'codex']} blocked={['claude']} />);
    expect(text()).toContain('Codex · 이 컴퓨터에 있음'); // 조사: only Codex left → text, no picker
    const select = container.querySelector('select') as HTMLSelectElement; // 작성(either): Codex · 나 · (꺼진) Claude Code
    expect(select.value).toBe('codex');
    const off = [...select.options].find((o) => o.value === 'claude-blocked')!;
    expect(off.disabled).toBe(true);
    expect(off.textContent).toBe('Claude Code · 회사 설정으로 쓸 수 없어요');
    expect(container.querySelectorAll('[data-testid=setup-blocked-note]')).toHaveLength(1);
    await act(async () => { startButton().click(); });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    expect((calls.find((c) => c.body)!.body as { roles: unknown }).roles).toEqual([{ role: '조사', runtime: 'codex' }, { role: '작성', runtime: 'codex' }]);
  });

  it('⑥ only blocked runtimes found → the full ⑥ screen; nothing found at all → ①', async () => {
    stub(() => new Response('{}'));
    await mount(<DesktopSetup code={CODE} runtimes={['claude']} blocked={['claude']} />);
    expect(text()).toContain('회사 설정 때문에 이 컴퓨터에서는 연결할 수 없어요');
    expect(text()).not.toContain('에이전트를 찾지 못했어요');
  });

  it('⑥(나) cause unknown: a neutral card that does not claim the cause', async () => {
    const retry = vi.fn();
    stub(() => new Response('{}'));
    await mount(<ToolsNotConnected onRetry={retry} />);
    expect(text()).toContain('에이전트에 Sprintable이 아직 연결되지 않았어요');
    expect(text()).toContain('터미널에서 작업 폴더를 믿을지 묻고 있다면 먼저 믿는다고 답해 주세요');
    await act(async () => { (container.querySelector('button') as HTMLButtonElement).click(); });
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('the setup values come after # and leave the address as soon as they are read (PO 09:45Z)', async () => {
    stub(() => new Response('{}'));
    window.history.replaceState(null, '', `/desktop/setup#code=${CODE}&setup=s-0&runtimes=claude`);
    await mount(<DesktopSetupEntry />);
    expect(window.location.hash).toBe('');
    expect(window.location.href).not.toContain(CODE);
    expect(text()).toContain('에이전트를 이 컴퓨터에서 시작해요');
    await act(async () => { root.unmount(); }); root = createRoot(container);
    window.history.replaceState(null, '', '/desktop/setup');
    stub(() => new Response('{}'));
    await mount(<DesktopSetupEntry />);
    expect(text()).toContain('데스크톱 앱에서 열어 주세요'); // nothing after # and nothing carried: a browser visit (AC5)
  });

  it('values that arrive after the page is up (same-document # change — the app reopens after an email login) are read and taken off the address (dev 실측 15:24Z)', async () => {
    stub(() => new Response('{}'));
    window.history.replaceState(null, '', '/desktop/setup');
    await mount(<DesktopSetupEntry />);
    expect(text()).toContain('데스크톱 앱에서 열어 주세요');
    await setHash(`code=${CODE}&setup=s-1&runtimes=claude`);
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
    expect(text()).toContain('에이전트를 이 컴퓨터에서 시작해요');
    expect(window.location.hash).toBe('');
    expect(window.location.href).not.toContain(CODE);
    // a newer code (the app restarted the setup) replaces the older one — «시작» sends the newer code
    const NEWER = `${'Z'.repeat(20)}_-${'y'.repeat(21)}`;
    await setHash(`code=${NEWER}&setup=s-2&runtimes=claude`);
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
    expect(window.location.href).not.toContain(NEWER);
    await act(async () => { startButton().click(); });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    expect((calls.find((c) => c.url.includes('/confirm'))!.body as { code: string }).code).toBe(NEWER);
    // an unrelated # (an in-page anchor) is left alone and changes nothing
    await setHash('section-2');
    expect(window.location.hash).toBe('#section-2');
  });

  it('when the router query changes (the shell adds ?p=), setup values back in the address are taken off again (dev 실측 15:31Z)', async () => {
    stub(() => new Response('{}'));
    sp.value = new URLSearchParams('');
    window.history.replaceState(null, '', `/desktop/setup#code=${CODE}&setup=s-0&runtimes=claude`);
    await mount(<DesktopSetupEntry />);
    expect(window.location.hash).toBe('');
    // the router's replace put the old address (with #) back and changed the query
    window.history.replaceState(null, '', `/desktop/setup?p=p-1#code=${CODE}&setup=s-0&runtimes=claude`);
    sp.value = new URLSearchParams('p=p-1');
    await mount(<DesktopSetupEntry />);
    expect(window.location.hash).toBe('');
    expect(window.location.search).toBe('?p=p-1');
    expect(text()).toContain('에이전트를 이 컴퓨터에서 시작해요'); // the form stays (values were in memory)
    sp.value = null;
  });

  it('every setup card wraps Korean by words (break-keep — Yuna 00:43Z: «없 / 어요» at 390)', async () => {
    stub(() => new Response('{}'));
    await mount(<DesktopSetup code={CODE} runtimes={['claude']} />);
    expect(container.firstElementChild!.className).toContain('break-keep');
    await act(async () => { root.unmount(); }); root = createRoot(container);
    recipesNow = () => new Response(JSON.stringify({ recipes: [] }), { status: 200 });
    await mount(<DesktopSetup code={CODE} runtimes={['claude']} />);
    expect(container.firstElementChild!.className).toContain('break-keep');
    recipesNow = () => new Response(JSON.stringify({ recipes: RECIPES }), { status: 200 });
    await act(async () => { root.unmount(); }); root = createRoot(container);
    await mount(<OpenInDesktopApp />);
    expect(container.firstElementChild!.className).toContain('break-keep');
  });

  it('the list is the server\'s (4831): drawn as it comes; a key shown as a name or a people-only card never shows (display guard)', async () => {
    const extra = [
      { id: 'rec-key', key: 'org.moonklabs.work.gate_cycle', name: 'org.moonklabs.work.gate_cycle', roles: [{ role: '작업', kind: 'agent' as const, stages: ['a'] }] },
      { id: 'rec-people', key: 'org.people_only', name: '사람만', roles: [{ role: '검토', kind: 'human' as const, stages: ['a'] }] },
      // approval-only either role — the server sends it as a row; the web used to drop it (→ roles_invalid at «시작»)
      { id: 'rec-loop', key: 'preset.loop_agency', name: '루프 대행', roles: [{ role: '기획', kind: 'agent' as const, stages: ['plan'] }, { role: '검수', kind: 'either' as const, stages: ['approve'] }] },
    ];
    RECIPES.push(...extra);
    try {
      stub(() => new Response(JSON.stringify({ setup_id: 's', members: [], work_item_id: 'w' }), { status: 200 }));
      await mount(<DesktopSetup code={CODE} runtimes={['claude']} />);
      const ids = [...container.querySelectorAll('input[name=recipe]')].map((i) => (i as HTMLInputElement).value);
      expect(ids).toEqual(['rec-1', 'rec-2', 'rec-loop']);
      expect(text()).not.toContain('org.moonklabs.work.gate_cycle');
      await act(async () => { (container.querySelector('input[value=rec-loop]') as HTMLInputElement).click(); });
      await act(async () => { startButton().click(); });
      for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
      expect((calls.find((c) => c.url.includes('/confirm'))!.body as { roles: unknown }).roles).toEqual([{ role: '기획', runtime: 'claude' }, { role: '검수', runtime: 'claude' }]);
    } finally { RECIPES.splice(RECIPES.length - extra.length, extra.length); }
  });

  it('an empty list → «이 컴퓨터에서 시작할 수 있는 레시피가 없어요» · [다시 확인] reads the list again (Yuna 00:25Z); a failed read → «레시피 목록을 불러오지 못했어요» (not ⑤) · [다시 시도] reads the list again (not «시작»)', async () => {
    recipesNow = () => new Response(JSON.stringify({ recipes: [] }), { status: 200 });
    stub(() => new Response('{}'));
    await mount(<DesktopSetup code={CODE} runtimes={['claude']} />);
    expect(text()).toContain('이 컴퓨터에서 시작할 수 있는 레시피가 없어요');
    expect(text()).toContain('조직의 레시피에서 그런 레시피를 켠 뒤 다시 확인해 주세요');
    expect(container.querySelectorAll('a').length).toBe(0); // no link away (the code is in memory only)
    recipesNow = () => new Response(JSON.stringify({ recipes: RECIPES }), { status: 200 });
    await act(async () => { ([...container.querySelectorAll('button')].find((b) => b.textContent === '다시 확인') as HTMLButtonElement).click(); });
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
    expect(startButton()).toBeTruthy();
    await act(async () => { root.unmount(); }); root = createRoot(container);

    recipesNow = () => new Response('{}', { status: 503 });
    stub(() => new Response('{}'));
    await mount(<DesktopSetup code={CODE} runtimes={['claude']} />);
    // its own card: nothing is chosen yet, so ⑤'s «고른 레시피와 설정은 그대로» would be false (PO 01:00Z · Yuna v18)
    expect(text()).toContain('레시피 목록을 불러오지 못했어요');
    expect(text()).toContain('인터넷 연결을 확인하거나 잠시 뒤 다시 시도해 주세요.');
    expect(text()).not.toContain('고른 레시피와 설정은 그대로');
    recipesNow = () => new Response(JSON.stringify({ recipes: RECIPES }), { status: 200 });
    const before = calls.filter((c) => c.url.includes('/api/desktop/recipes')).length;
    await act(async () => { ([...container.querySelectorAll('button')].find((b) => b.textContent === '다시 시도') as HTMLButtonElement).click(); });
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
    expect(calls.filter((c) => c.url.includes('/api/desktop/recipes')).length).toBe(before + 1);
    expect(calls.some((c) => c.url.includes('/confirm'))).toBe(false);
    expect(startButton()).toBeTruthy();
    recipesNow = () => new Response(JSON.stringify({ recipes: RECIPES }), { status: 200 });
  });

  it('the web keeps no setup value anywhere (no storage) and has no login-page branch for the desktop (PO 09:58Z)', async () => {
    stub(() => new Response('{}'));
    window.history.replaceState(null, '', `/desktop/setup#code=${CODE}&setup=s-1&runtimes=claude`);
    await mount(<DesktopSetupEntry />);
    expect(JSON.stringify({ ...sessionStorage }) + JSON.stringify({ ...localStorage })).not.toContain(CODE);
    expect(events().filter((e) => e.event === 'desktop_setup_signed_in')).toEqual([]); // the shell sends it now
    const fs = await import('node:fs');
    const path = await import('node:path');
    const login = fs.readFileSync(path.join(__dirname, '../../app/login/page.tsx'), 'utf8');
    expect(login).not.toMatch(/desktop/i);
  });

  it('4426 · AC2: while a setup runs in this tab, opening a guide link sends desktop_doc_opened; other links and other tabs send nothing', async () => {
    stub(() => new Response('{}'));
    await mount(<><DesktopSetup code={CODE} runtimes={['claude']} setupId="s-2" /><DesktopSetupDocWatch /><a href="https://sprintable.ai/ko/blog/desktop" onClick={(e) => e.preventDefault()}>guide</a><a href="https://example.com/kanban" onClick={(e) => e.preventDefault()}>board</a></>);
    const [guide, board] = [...container.querySelectorAll('a')].filter((a) => ['guide', 'board'].includes(a.textContent ?? ''));
    await act(async () => { board!.click(); guide!.click(); });
    expect(events().map((e) => [e.event, e.session_id])).toEqual([['desktop_doc_opened', 's-2']]);
    sessionStorage.clear();
    await act(async () => { guide!.click(); });
    expect(events()).toHaveLength(1);
  });

  it('opened without a code (a browser, AC5): «데스크톱 앱에서 열어 주세요» with «앱 열기»', async () => {
    stub(() => new Response('{}'));
    await mount(<OpenInDesktopApp />);
    expect(text()).toContain('데스크톱 앱에서 열어 주세요');
    expect((container.querySelector(`a[href="${SETUP_APP_LINK}"]`) as HTMLAnchorElement).textContent).toBe('앱 열기');
  });
});

const SETUP_ID = '11111111-2222-4333-8444-555555555555';
type Sig = { tools_connected: { member_id: string; at: string }[]; first_task_handed_at: string | null; first_result_at: string | null; workdir_fallback_at: string | null; blocked: { at: string; reason: string | null } | null };
const status = (state: string, sig: Partial<Sig> = {}) => ({
  setup_id: SETUP_ID, device_name: 'mac', state, recipe_name: '마케팅 루프', work_item_id: 'w-1',
  members: [
    { stage: 'research', role: '조사', member_id: 'm1', kind: 'agent', runtime: 'claude' },
    { stage: 'draft', role: '작성', member_id: 'm2', kind: 'agent', runtime: 'codex' },
    { stage: 'review', role: '연출', member_id: 'h1', kind: 'human', runtime: null },
  ],
  signals: { tools_connected: [], first_task_handed_at: null, first_result_at: null, workdir_fallback_at: null, blocked: null, ...sig },
});

describe('[SID:4427] after «시작» — progress from the setup status (PO 12:25Z rules · Yuna v13 copy)', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] }); vi.setSystemTime(Date.parse('2026-09-30T00:00:00Z')); });
  afterEach(() => { vi.useRealTimers(); });
  const tick = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); }); };
  const startSetup = async () => {
    stub(() => new Response(JSON.stringify({ setup_id: SETUP_ID, members: [], work_item_id: 'w-1' }), { status: 200 }));
    await mount(<DesktopSetup code={CODE} runtimes={['claude', 'codex']} setupId={SETUP_ID} />);
    await act(async () => { startButton().click(); });
    await tick(0);
  };
  const polls = () => calls.filter((c) => c.url.includes('/api/desktop/setups/')).length;
  const resultButton = () => [...container.querySelectorAll('a, button')].find((b) => b.textContent === '결과 보기') as HTMLElement;

  it('the three steps · the trust note only between handed over and connected · «결과 보기» off with its reason until the result', async () => {
    statusNow = () => status('waiting_for_app');
    await startSetup();
    expect(container.querySelector('h1')?.textContent).toBe('에이전트를 시작하고 있어요');
    expect(text()).toContain('에이전트를 준비하고 있어요');
    expect(text()).toContain('«마케팅 루프»를 조사 에이전트에게 건네는 중이에요');
    expect(container.querySelector('[data-testid=setup-trust-hint]')).toBeNull();
    expect((resultButton() as HTMLButtonElement).disabled).toBe(true);
    expect(text()).toContain('결과가 나오면 눌러서 일감으로 가요');

    statusNow = () => status('handed_over', { tools_connected: [{ member_id: 'm1', at: 'x' }] });
    await tick(2_000);
    expect(container.querySelector('[data-testid=setup-trust-hint]')?.textContent).toContain('처음 켤 때 에이전트가 작업 폴더를 믿을지 물을 수 있어요');

    statusNow = () => status('handed_over', { tools_connected: [{ member_id: 'm1', at: 'x' }, { member_id: 'm2', at: 'x' }], workdir_fallback_at: 'x' });
    await tick(2_000);
    expect(text()).toContain('에이전트를 준비했어요');
    expect(text()).toContain('조사 · Claude Code, 작성 · Codex');
    expect(container.querySelector('[data-testid=setup-trust-hint]')).toBeNull();
    expect(container.querySelector('[data-testid=setup-workdir-fallback]')?.textContent).toBe('고른 폴더를 쓸 수 없어 기본 폴더(~/Sprintable/마케팅 루프)에서 시작했어요 — 작업 폴더는 홈 폴더 안의 한 폴더여야 해요');

    statusNow = () => status('handed_over', { tools_connected: [{ member_id: 'm1', at: 'x' }, { member_id: 'm2', at: 'x' }], first_result_at: 'y' });
    await tick(2_000);
    expect(text()).toContain('첫 일감을 맡겼어요'); // a result means it was handed over
    expect(text()).toContain('첫 결과가 나왔어요');
    expect(container.querySelector('h1')?.textContent).toBe('에이전트를 시작했어요');
    expect(resultButton().getAttribute('href')).toBe('/o/proj/flow?story=w-1');
    expect(text()).not.toContain('결과가 나오면 눌러서 일감으로 가요');
    const n = polls();
    await tick(10_000);
    expect(polls()).toBe(n); // stops once the result is in
  });

  it('«설정 진행 중» for doc counting (AC2): refreshed by every status read — a doc opened 31 min in still counts; gone once the result is in (PO 13:00Z)', async () => {
    const { activeSetupId } = await import('@/lib/desktop-setup');
    statusNow = () => status('handed_over', { tools_connected: [{ member_id: 'm1', at: 'x' }, { member_id: 'm2', at: 'x' }] });
    await startSetup();
    await tick(31 * 60_000);
    expect(activeSetupId()).toBe(SETUP_ID);
    statusNow = () => status('handed_over', { tools_connected: [{ member_id: 'm1', at: 'x' }, { member_id: 'm2', at: 'x' }], first_result_at: 'y' });
    await tick(2_000);
    expect(activeSetupId()).toBeNull();
  });

  it('⑦ «아직» after handed over + 180 s with a missing connection; it goes away when the connection comes', async () => {
    statusNow = () => status('handed_over', { tools_connected: [{ member_id: 'm1', at: 'x' }] });
    await startSetup();
    await tick(178_000);
    expect(text()).not.toContain('에이전트에 Sprintable이 아직 연결되지 않았어요');
    await tick(4_000);
    expect(text()).toContain('에이전트에 Sprintable이 아직 연결되지 않았어요');
    statusNow = () => status('handed_over', { tools_connected: [{ member_id: 'm1', at: 'x' }, { member_id: 'm2', at: 'x' }] });
    await tick(2_000);
    expect(text()).not.toContain('아직 연결되지 않았어요');
    expect(text()).toContain('에이전트를 준비했어요');
  });

  it('blocked after start → ⑥ · the code ran out before the app took it → ④', async () => {
    statusNow = () => status('handed_over', { blocked: { at: 'x', reason: 'managed_mcp' } });
    await startSetup();
    expect(text()).toContain('회사 설정 때문에 이 컴퓨터에서는 연결할 수 없어요');
    await act(async () => { root.unmount(); }); root = createRoot(container);
    statusNow = () => status('not_handed_over');
    await startSetup();
    expect(text()).toContain('설정 시간이 지났어요');
  });
});

describe('[SID:4427] ③ limit and the recipe line (Yuna table)', () => {
  it('numbers only when the server gives both; otherwise the second sentence alone · [에이전트 정리하기]', async () => {
    stub(() => new Response(JSON.stringify({ error: { code: 'PLAN_LIMIT_EXCEEDED', resource: 'agent', needed: 2, available: 1 } }), { status: 402 }));
    await mount(<DesktopSetup code={CODE} runtimes={['claude']} />);
    await act(async () => { startButton().click(); });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    expect(text()).toContain('이 레시피는 에이전트 2개가 필요한데, 지금 1개만 더 만들 수 있어요. 쓰지 않는 에이전트를 정리하거나');
    expect(([...container.querySelectorAll('a')].find((a) => a.textContent === '에이전트 정리하기') as HTMLAnchorElement).getAttribute('href')).toContain('/organization/workforce');
    await act(async () => { root.unmount(); }); root = createRoot(container);

    stub(() => new Response(JSON.stringify({ error: { code: 'PLAN_LIMIT_EXCEEDED', resource: 'agent', limit: 5, current: 5 } }), { status: 402 }));
    await mount(<DesktopSetup code={CODE} runtimes={['claude']} />);
    await act(async () => { startButton().click(); });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    expect(text()).toContain('이 조직에서 만들 수 있는 에이전트 수를 넘어요');
    expect(text()).not.toContain('필요한데');
    await act(async () => { ([...container.querySelectorAll('button')].find((b) => b.textContent === '레시피 다시 고르기') as HTMLButtonElement).click(); });
    expect(startButton()).toBeTruthy(); // back to the choices
  });

  it('each recipe card says its roles in the rows\' order (orderedRecipeRoles · Yuna 12:49Z): «역할 3 · 연출 · 조사 · 작성»', async () => {
    stub(() => new Response('{}'));
    await mount(<DesktopSetup code={CODE} runtimes={['claude']} />);
    expect(text()).toContain('역할 3 · 연출 · 조사 · 작성');
    expect(text()).toContain('역할 1 · 조사');
  });
});

describe('[SID:4427] en copy (Yuna 08:34Z)', () => {
  it('agent count is plural-aware in English', async () => {
    const { createTranslator } = await import('next-intl');
    const en = (await import('../../../messages/en.json')).default as Record<string, unknown>;
    const t = createTranslator({ locale: 'en', messages: en, namespace: 'desktop.setup' }) as unknown as (key: string, values?: Record<string, string | number>) => string;
    expect(t('startNote', { n: 1 })).toBe('Creates 1 agent on this computer and hands over the first task');
    expect(t('startNote', { n: 2 })).toBe('Creates 2 agents on this computer and hands over the first task');
    expect(t('startNoteWithMe', { n: 1, roles: 'Director', josa: '' })).toBe('Creates 1 agent on this computer and hands over the first task · you take Director');
  });
});
