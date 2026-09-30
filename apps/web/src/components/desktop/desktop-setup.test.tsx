// @vitest-environment jsdom
//
// story #4427 — 웹 설정 페이지: 기본값이 채워진 채 열림 · «시작» 한 번 = confirm 하나 · 실패 갈래 · 코드 없이 온 경우.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

const { ctx, sp } = vi.hoisted(() => ({ ctx: vi.fn(), sp: { value: null as URLSearchParams | null } }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ctx() }));
// the query the router reports (the dashboard shell adds ?p= with a router replace)
vi.mock('next/navigation', async (orig) => ({ ...(await orig<typeof import('next/navigation')>()), useSearchParams: () => sp.value }));

import { DesktopSetup, DesktopSetupEntry, OpenInDesktopApp, SETUP_APP_LINK, ToolsNotConnected, failureForCode, inviteUntilDate } from './desktop-setup';
import { DesktopSetupDocWatch } from './desktop-setup-doc-watch';
import { SetupProgressView } from './desktop-setup-progress';

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
    expect(failureForCode('roles_invalid')).toBe('recipes-changed');
    expect(failureForCode('recipe_too_large')).toBe('recipe-too-big');
    expect(failureForCode('no_agent_role')).toBe('recipes-changed');
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

  it('⑥(나) cause unknown: a neutral card that does not claim the cause — with a Claude Code agent, how to answer its trust question', async () => {
    const retry = vi.fn();
    stub(() => new Response('{}'));
    await mount(<ToolsNotConnected onRetry={retry} claude />);
    expect(text()).toContain('에이전트에 Sprintable이 아직 연결되지 않았어요');
    // Yuna v27 · PO 12:11Z: the CLI's own English choice quoted as it is; which line starts selected differs by Claude Code
    // version (2.1.285 = No · 2.1.142 = Yes), so the text says where ❯ must be, not which key to press
    expect(text()).toContain('Claude Code 터미널이 작업 폴더를 믿을지 묻고 있다면 화살표 키로 ❯를 «Yes, I trust this folder»에 맞춘 뒤 Enter를 눌러 주세요. 그래도 안 붙으면 회사 설정이나 네트워크 때문일 수 있어요');
    await act(async () => { (container.querySelector('button') as HTMLButtonElement).click(); });
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('⑥(나) cause unknown with Codex only: no trust sentence (Codex does not ask it)', async () => {
    stub(() => new Response('{}'));
    await mount(<ToolsNotConnected onRetry={vi.fn()} claude={false} />);
    expect(text()).toContain('에이전트는 켜졌지만 Sprintable 일감을 받을 연결이 아직 붙지 않았어요. 회사 설정이나 네트워크 때문일 수 있어요');
    expect(text()).not.toMatch(/믿을지|trust/);
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

// PO 10:40Z ② (Yuna 0747aadd v23) — the default recipe is «블로그 글» (preset.marketing.blog_article): when the list has it, it
// comes first and is chosen (seen on the first screen at 360 too) · no «recommended» mark; when it is not there, the server's first
describe('[SID:4427] the default recipe', () => {
  const recipe = (id: string, key: string, name: string, org_id: string | null) => ({
    id, key, name, org_id, roles: [{ role: '작성', kind: 'agent' as const, stages: ['draft'] }],
  });
  const radios = () => [...container.querySelectorAll('input[type=radio][name=recipe]')] as HTMLInputElement[];

  it('«블로그 글» in the list: first, and chosen — not the server\'s first', async () => {
    recipesNow = () => new Response(JSON.stringify({ recipes: [
      recipe('r-kanban', 'preset.workflow.kanban_simple', '칸반 심플', null),
      recipe('r-video', 'preset.marketing.video_production', '영상 제작', null),
      recipe('r-blog', 'preset.marketing.blog_article', '블로그 글', null),
    ] }), { status: 200 });
    stub(() => new Response('{}', { status: 200 }));
    await mount(<DesktopSetup code={CODE} runtimes={['claude', 'codex']} />);
    expect(radios().map((r) => r.value)).toEqual(['r-blog', 'r-kanban', 'r-video']);
    expect(radios().find((r) => r.checked)?.value).toBe('r-blog');
    expect(container.textContent).not.toMatch(/추천/);
  });

  it('no «블로그 글» (the org turned it off): the server\'s first stays first and chosen', async () => {
    recipesNow = () => new Response(JSON.stringify({ recipes: [
      recipe('r-kanban', 'preset.workflow.kanban_simple', '칸반 심플', null),
      recipe('r-video', 'preset.marketing.video_production', '영상 제작', null),
    ] }), { status: 200 });
    stub(() => new Response('{}', { status: 200 }));
    await mount(<DesktopSetup code={CODE} runtimes={['claude', 'codex']} />);
    expect(radios().map((r) => r.value)).toEqual(['r-kanban', 'r-video']);
    expect(radios().find((r) => r.checked)?.value).toBe('r-kanban');
  });

  it("an org's own recipe with the same key is not the default (only the platform preset is)", async () => {
    recipesNow = () => new Response(JSON.stringify({ recipes: [
      recipe('r-kanban', 'preset.workflow.kanban_simple', '칸반 심플', null),
      recipe('r-own', 'preset.marketing.blog_article', '우리 블로그', 'org-1'),
    ] }), { status: 200 });
    stub(() => new Response('{}', { status: 200 }));
    await mount(<DesktopSetup code={CODE} runtimes={['claude', 'codex']} />);
    expect(radios().find((r) => r.checked)?.value).toBe('r-kanban');
  });
});

describe('[SID:4427] either rows can be «나» · no agent row · the recipe over the request limits (Kadir 4834 · PO 05:21Z ⒜ · Yuna v20/v21)', () => {
  const setOwnerSelect = async (role: string, value: string) => {
    const sel = container.querySelector(`select[aria-label*="${role}"]`) as HTMLSelectElement;
    await act(async () => { sel.value = value; sel.dispatchEvent(new Event('change', { bubbles: true })); });
  };
  const chooseLabel = '레시피 다시 고르기';

  it('an either row set to «나» goes in the body as {role, owner: me}; the human-only row still is not sent', async () => {
    stub(() => new Response('{}', { status: 200 }));
    await mount(<DesktopSetup code={CODE} runtimes={['claude']} />);
    await setOwnerSelect('작성', 'me');
    calls = [];
    await act(async () => { startButton().click(); });
    const sent = calls.find((c) => c.url.includes('/api/desktop/setup-codes/'))!.body as { roles: unknown[] };
    expect(sent.roles).toEqual([{ role: '조사', runtime: 'claude' }, { role: '작성', owner: 'me' }]);
  });

  it('agents found but every either row set to «나»: «시작» off and the count line becomes the reason (not ①)', async () => {
    recipesNow = () => new Response(JSON.stringify({ recipes: [{ id: 'rec-e', key: 'org.either', name: '둘 다 되는 한 명', roles: [{ role: '작성', kind: 'either', stages: ['draft'] }] }] }), { status: 200 });
    stub(() => new Response('{}', { status: 200 }));
    await mount(<DesktopSetup code={CODE} runtimes={['claude']} />);
    expect(startButton().disabled).toBe(false);
    await setOwnerSelect('작성', 'me');
    expect(startButton().disabled).toBe(true);
    expect(text()).toContain('에이전트가 맡는 역할이 하나는 있어야 시작할 수 있어요 — 역할 하나를 에이전트로 바꿔 주세요.');
    expect(text()).not.toContain('에이전트 0개');
    expect(text()).not.toContain('에이전트를 찾지 못했어요');
    await setOwnerSelect('작성', 'claude');
    expect(startButton().disabled).toBe(false);
  });

  it('the server still says no_agent_role → «레시피가 달라졌어요» (agents were found, so ① would be false · Yuna · PO 06:52Z)', async () => {
    stub(() => new Response(JSON.stringify({ data: null, error: { code: 'no_agent_role' } }), { status: 422 }));
    await mount(<DesktopSetup code={CODE} runtimes={['claude']} />);
    await act(async () => { startButton().click(); });
    expect(text()).toContain('레시피가 달라졌어요');
    expect(text()).not.toContain('이 컴퓨터에서 에이전트를 찾지 못했어요');
    expect([...container.querySelectorAll('button')].map((x) => x.textContent)).toEqual(['레시피 다시 불러오기']);
  });

  it('a recipe over the request limits (422 recipe_too_large) → «이 레시피는 여기서 시작할 수 없어요» [레시피 다시 고르기] back to the choice; no retry, no «잠시 뒤»; another 422 body fault is not this card', async () => {
    stub(() => new Response(JSON.stringify({ data: null, error: { code: 'recipe_too_large' } }), { status: 422 }));
    await mount(<DesktopSetup code={CODE} runtimes={['claude']} />);
    await act(async () => { startButton().click(); });
    expect(text()).toContain('이 레시피는 여기서 시작할 수 없어요');
    expect(text()).toContain('역할이 너무 많거나 역할 이름이 너무 길어요. 다른 레시피를 골라 주세요.');
    expect([...container.querySelectorAll('button')].map((b) => b.textContent)).toEqual([chooseLabel]);
    await act(async () => { [...container.querySelectorAll('button')].find((b) => b.textContent === chooseLabel)!.click(); });
    expect(container.querySelector('input[name=recipe]')).not.toBeNull();
    // a body fault (roles_invalid · FastAPI's own 422 with detail) is not taken for this card
    for (const body of [{ data: null, error: { code: 'roles_invalid' } }, { detail: [{ type: 'too_long', loc: ['body', 'roles'], msg: 'x' }] }]) {
      await act(async () => { root.unmount(); });
      root = createRoot(container);
      stub(() => new Response(JSON.stringify(body), { status: 422 }));
      await mount(<DesktopSetup code={CODE} runtimes={['claude']} />);
      await act(async () => { startButton().click(); });
      expect(text()).not.toContain('이 레시피는 여기서 시작할 수 없어요');
    }
  });

  it('roles_invalid → «레시피가 달라졌어요» [레시피 다시 불러오기]: the list is read again and the choice comes back; the same confirm is not sent again (Yuna v22 · PO 06:08Z)', async () => {
    stub(() => new Response(JSON.stringify({ data: null, error: { code: 'roles_invalid' } }), { status: 422 }));
    await mount(<DesktopSetup code={CODE} runtimes={['claude']} />);
    await act(async () => { startButton().click(); });
    expect(text()).toContain('레시피가 달라졌어요');
    expect(text()).toContain('이 페이지를 연 뒤 레시피나 역할이 바뀌어 지금 고른 대로는 시작할 수 없어요. 목록을 다시 불러와 골라 주세요.');
    expect(text()).not.toContain('잠시 뒤');
    expect([...container.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['레시피 다시 불러오기']);
    calls = [];
    await act(async () => { [...container.querySelectorAll('button')].find((b) => b.textContent === '레시피 다시 불러오기')!.click(); });
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
    expect(calls.map((c) => c.url)).toEqual(['/api/desktop/recipes']);
    expect(container.querySelector('input[name=recipe]')).not.toBeNull();
  });

  it('a platform preset (org_id null) is named in the viewer\'s language; an organization\'s recipe keeps its own name', async () => {
    recipesNow = () => new Response(JSON.stringify({ recipes: [
      { id: 'p-1', key: 'preset.workflow.two_step', name: 'Two step (raw)', org_id: null, roles: [{ role: '조사', kind: 'agent', stages: ['a'] }] },
      { id: 'o-1', key: 'preset.workflow.two_step', name: '우리 팀 두 단계', org_id: 'org-1', roles: [{ role: '조사', kind: 'agent', stages: ['a'] }] },
    ] }), { status: 200 });
    stub(() => new Response('{}', { status: 200 }));
    await mount(<DesktopSetup code={CODE} runtimes={['claude']} />);
    expect(text()).toContain('제출·검토');
    expect(text()).not.toContain('Two step (raw)');
    expect(text()).toContain('우리 팀 두 단계');
  });
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

  // PO 10:39Z ① (Mirko's probe) — a platform preset is named on the progress screen as the list names it (its translation by
  // key), not by the stored name: «3단계 칸반», not «칸반 심플» — also when the page is opened again (no name from the list)
  it('a platform preset is named by its translation on the progress screen, even when reopened without the list', async () => {
    statusNow = () => ({ ...status('waiting_for_app'), recipe_name: '칸반 심플', recipe: { key: 'preset.workflow.kanban_simple', name: '칸반 심플', org_id: null } });
    stub(() => new Response('{}', { status: 200 }));
    await mount(<SetupProgressView setupId={SETUP_ID} recipeName="" />);
    await tick(0);
    expect(text()).toContain('«3단계 칸반»을 조사 에이전트에게 건네는 중이에요');
    expect(container.querySelector('header p')?.textContent).toContain('3단계 칸반');
    expect(text()).not.toContain('칸반 심플');
  });

  it("an org's own recipe keeps its own name (no translation for it)", async () => {
    statusNow = () => ({ ...status('waiting_for_app'), recipe: { key: 'org.marketing_loop', name: '마케팅 루프', org_id: 'org-1' } });
    stub(() => new Response('{}', { status: 200 }));
    await mount(<SetupProgressView setupId={SETUP_ID} recipeName="" />);
    await tick(0);
    expect(text()).toContain('«마케팅 루프»를 조사 에이전트에게 건네는 중이에요');
  });

  // Yuna v24 · PO 11:19Z — the trust note is Claude Code's question: with only Codex agents it is not shown at all
  it('Codex agents only: no trust note between handed over and connected', async () => {
    const codexOnly = (sig: Partial<Sig>) => ({ ...status('handed_over', sig), members: [{ stage: 'research', role: '조사', member_id: 'm1', kind: 'agent', runtime: 'codex' }] });
    statusNow = () => codexOnly({ tools_connected: [] });
    stub(() => new Response('{}', { status: 200 }));
    await mount(<SetupProgressView setupId={SETUP_ID} recipeName="" />);
    await tick(0);
    expect(text()).toContain('에이전트를 준비하고 있어요');
    expect(container.querySelector('[data-testid=setup-trust-hint]')).toBeNull();
  });

  // story 4433 (Yuna v26): an agent that stopped before the first result — one block under the steps, the roles on one line,
  // the trust sentence only when a Claude Code agent is among them; ③ stops spinning; no field (today's server) → nothing
  it('[SID:4433] a stopped agent: the block under the steps · ③ a still ring · Claude → the trust sentence · started again → gone', async () => {
    const block = () => container.querySelector('[data-testid=setup-agent-stopped]');
    const third = () => container.querySelectorAll('ol > li[data-state]')[2] as HTMLElement | undefined;
    statusNow = () => status('handed_over', { tools_connected: [{ member_id: 'm1', at: 'x' }] });
    stub(() => new Response('{}', { status: 200 }));
    await mount(<SetupProgressView setupId={SETUP_ID} recipeName="" />);
    await tick(0);
    expect(block()).toBeNull(); // no agents_ended field
    expect(third()?.dataset.paused).toBeUndefined();

    const ended = (member_id: string, runtime: string, restarted_at: string | null = null) => ({ member_id, at: '2026-09-30T12:00:05Z', runtime, exit_code: 1, restarted_at });
    statusNow = () => ({ ...status('handed_over'), signals: { ...status('handed_over').signals, agents_ended: [ended('m1', 'claude')] } });
    await tick(2_000);
    expect(block()?.textContent).toContain('조사 에이전트가 멈췄어요 — 창 아래 «이 컴퓨터의 에이전트» 줄에서 그 에이전트를 눌러 [다시 시작]을 눌러 주세요.');
    expect(block()?.textContent).toContain('다시 시작하면 작업 폴더를 믿을지 다시 물을 수 있어요 — 물으면 화살표 키로 ❯를 «Yes, I trust this folder»에 맞춘 뒤 Enter를 눌러 주세요.');
    expect(third()?.dataset.paused).toBe('true');
    expect(block()?.textContent).not.toMatch(/↓/); // true on either Claude version: no fixed key direction (PO 12:11Z · Yuna v27)
    expect(container.querySelector('[data-testid=setup-trust-hint]')).toBeNull();
    // the block comes after the steps and before «결과 보기»
    expect(!!(container.querySelector('ol')!.compareDocumentPosition(block()!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(!!(block()!.compareDocumentPosition(container.querySelector('footer')!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);

    // two agents, Codex only among the stopped ones would drop the trust sentence; both here → one line, the flow's order
    statusNow = () => ({ ...status('handed_over'), signals: { ...status('handed_over').signals, agents_ended: [ended('m2', 'codex'), ended('m1', 'claude')] } });
    await tick(2_000);
    expect(block()?.textContent).toContain('조사 · 작성 에이전트가 멈췄어요');
    statusNow = () => ({ ...status('handed_over'), signals: { ...status('handed_over').signals, agents_ended: [ended('m2', 'codex')] } });
    await tick(2_000);
    expect(block()?.textContent).toContain('작성 에이전트가 멈췄어요');
    expect(block()?.textContent).not.toContain('믿을지');

    // started again after it stopped → the block goes and ③ spins again
    statusNow = () => ({ ...status('handed_over'), signals: { ...status('handed_over').signals, agents_ended: [ended('m2', 'codex', '2026-09-30T12:00:09Z')] } });
    await tick(2_000);
    expect(block()).toBeNull();
    expect(third()?.dataset.paused).toBeUndefined();
  });

  it('[SID:4433] ② done while another agent is not connected → ① drawn done · «… 에이전트는 아직 준비하고 있어요» muted under it, no pairs line', async () => {
    const first = () => container.querySelectorAll('ol > li[data-state]')[0] as HTMLElement | undefined;
    statusNow = () => status('handed_over', { tools_connected: [{ member_id: 'm1', at: 'x' }], first_task_handed_at: '2026-09-30T12:00:02Z' });
    stub(() => new Response('{}', { status: 200 }));
    await mount(<SetupProgressView setupId={SETUP_ID} recipeName="" />);
    await tick(0);
    expect(first()?.dataset.state).toBe('done');
    const line = container.querySelector('[data-testid=setup-still-preparing]');
    expect(line?.textContent).toBe('작성 에이전트는 아직 준비하고 있어요');
    expect(line?.className).toContain('text-muted-foreground');
    // ①'s own detail (the «역할 · 런타임» pairs only once every agent is ready) — still three steps for a screen reader
    expect(first()?.textContent).toBe('에이전트를 준비했어요작성 에이전트는 아직 준비하고 있어요');
    expect(first()!.contains(line)).toBe(true);
    expect(container.querySelectorAll('ol > li').length).toBe(3);
    statusNow = () => status('handed_over', { tools_connected: [{ member_id: 'm1', at: 'x' }, { member_id: 'm2', at: 'x' }], first_task_handed_at: '2026-09-30T12:00:02Z' });
    await tick(2_000);
    expect(container.querySelector('[data-testid=setup-still-preparing]')).toBeNull();
    expect(first()?.textContent).toContain('조사 · Claude Code, 작성 · Codex');
  });

  // Yuna v29 · PO 15:59Z: a role name already ending in «에이전트» (ko) · «agent» / «에이전트» (en) gets no second one — the stopped
  // block · ②'s detail · the «still getting ready» line alike; the particle follows the name then
  it('[SID:4433] «에이전트» is not added twice: stopped block · ② detail · still-getting-ready line × role names × ko/en', async () => {
    const one = (name: string, sig: Record<string, unknown>) => ({ ...status('handed_over'), members: [{ stage: 'a', role: name, member_id: 'm1', kind: 'agent', runtime: 'claude' }], signals: { ...status('handed_over').signals, ...sig } });
    const two = (name: string) => ({ ...status('handed_over'), members: [{ stage: 'a', role: '조사', member_id: 'm0', kind: 'agent', runtime: 'claude' }, { stage: 'b', role: name, member_id: 'm1', kind: 'agent', runtime: 'codex' }],
      signals: { ...status('handed_over').signals, tools_connected: [{ member_id: 'm0', at: 'x' }], first_task_handed_at: '2026-09-30T12:00:02Z' } });
    const ended = [{ member_id: 'm1', at: '2026-09-30T12:00:05Z', runtime: 'claude', exit_code: 1, restarted_at: null }];
    const cases: [locale: 'ko' | 'en', name: string, stopped: string, handed: string, still: string][] = [
      ['ko', '에이전트', '에이전트가 멈췄어요 — ', '«마케팅 루프»를 에이전트에게 건네는 중이에요', '에이전트는 아직 준비하고 있어요'],
      ['ko', '블로그 에이전트', '블로그 에이전트가 멈췄어요 — ', '«마케팅 루프»를 블로그 에이전트에게 건네는 중이에요', '블로그 에이전트는 아직 준비하고 있어요'],
      ['ko', 'Writer', 'Writer 에이전트가 멈췄어요 — ', '«마케팅 루프»를 Writer 에이전트에게 건네는 중이에요', 'Writer 에이전트는 아직 준비하고 있어요'],
      ['en', '에이전트', '에이전트 stopped — ', 'Handing «마케팅 루프» to 에이전트', '에이전트 is still getting ready'],
      ['en', 'Research Agent', 'Research Agent stopped — ', 'Handing «마케팅 루프» to Research Agent', 'Research Agent is still getting ready'],
      ['en', 'Writer', 'The Writer agent stopped — ', 'Handing «마케팅 루프» to the Writer agent', 'The Writer agent is still getting ready'],
    ];
    ctx.mockReturnValue({ projectId: 'p-1', currentProjectSlug: 'proj', userName: '김지우', orgId: 'o-1', orgMemberships: [{ orgId: 'o-1', orgName: 'O', orgSlug: 'o', role: 'owner' }] });
    stub(() => new Response('{}', { status: 200 }));
    for (const [locale, name, stopped, handed, still] of cases) {
      const render = async (st: unknown) => {
        statusNow = () => st as ReturnType<typeof status>;
        await act(async () => { root.unmount(); });
        root = createRoot(container);
        await act(async () => { root.render(<NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul"><SetupProgressView setupId={SETUP_ID} recipeName="" /></NextIntlClientProvider>); });
        await tick(0);
      };
      await render(one(name, { agents_ended: ended }));
      expect(container.querySelector('[data-testid=setup-agent-stopped] p')?.textContent?.startsWith(stopped), `${locale} ${name} stopped: ${container.querySelector('[data-testid=setup-agent-stopped] p')?.textContent}`).toBe(true);
      await render(one(name, {}));
      expect(text(), `${locale} ${name} handed`).toContain(handed);
      await render(two(name));
      expect(container.querySelector('[data-testid=setup-still-preparing]')?.textContent, `${locale} ${name} still`).toBe(still);
    }
  });

  // PO 16:31Z (Kadir): the LAST role of a group decides, and a name with a trailing space is judged and drawn trimmed
  it('[SID:4433] a group: the last role decides «에이전트» · a trailing space is trimmed for the check and the words (ko/en)', async () => {
    const stoppedTwo = (a: string, b: string) => ({ ...status('handed_over'), members: [{ stage: 'a', role: a, member_id: 'm1', kind: 'agent', runtime: 'codex' }, { stage: 'b', role: b, member_id: 'm2', kind: 'agent', runtime: 'codex' }],
      signals: { ...status('handed_over').signals, agents_ended: ['m1', 'm2'].map((id) => ({ member_id: id, at: '2026-09-30T12:00:05Z', runtime: 'codex', exit_code: 1, restarted_at: null })) } });
    const cases: [locale: 'ko' | 'en', a: string, b: string, words: string][] = [
      ['ko', 'Writer', '에이전트', 'Writer · 에이전트가 멈췄어요 — '],
      ['ko', '에이전트', 'Writer', '에이전트 · Writer 에이전트가 멈췄어요 — '],
      ['en', 'Writer', '에이전트', 'Writer · 에이전트 stopped — '],
      ['en', '에이전트', 'Writer', 'The 에이전트 · Writer agents stopped — '],
      ['ko', 'Writer', '에이전트 ', 'Writer · 에이전트가 멈췄어요 — '],
      ['en', 'Writer', 'Research agent  ', 'Writer · Research agent stopped — '],
    ];
    ctx.mockReturnValue({ projectId: 'p-1', currentProjectSlug: 'proj', userName: '김지우', orgId: 'o-1', orgMemberships: [{ orgId: 'o-1', orgName: 'O', orgSlug: 'o', role: 'owner' }] });
    stub(() => new Response('{}', { status: 200 }));
    for (const [locale, a, b, words] of cases) {
      statusNow = () => stoppedTwo(a, b) as ReturnType<typeof status>;
      await act(async () => { root.unmount(); });
      root = createRoot(container);
      await act(async () => { root.render(<NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul"><SetupProgressView setupId={SETUP_ID} recipeName="" /></NextIntlClientProvider>); });
      await tick(0);
      const got = container.querySelector('[data-testid=setup-agent-stopped] p')?.textContent ?? '';
      expect(got.startsWith(words), `${locale} [${a}|${b}] → ${got}`).toBe(true);
    }
  });

  it('[SID:4433] one agent and it stopped → ① ② ③ all still rings · two agents, one stopped → the other\'s steps spin', async () => {
    const paused = () => [...container.querySelectorAll('ol > li[data-state]')].map((li) => (li as HTMLElement).dataset.paused === 'true');
    const ended = (id: string) => [{ member_id: id, at: '2026-09-30T12:00:05Z', runtime: 'claude', exit_code: 1, restarted_at: null }];
    statusNow = () => ({ ...status('handed_over'), members: [{ stage: 'a', role: '조사', member_id: 'm1', kind: 'agent', runtime: 'claude' }], signals: { ...status('handed_over').signals, agents_ended: ended('m1') } });
    stub(() => new Response('{}', { status: 200 }));
    await mount(<SetupProgressView setupId={SETUP_ID} recipeName="" />);
    await tick(0);
    expect(paused()).toEqual([true, true, true]);
    expect(container.querySelectorAll('ol .animate-spin').length).toBe(0);
    // two agents, the second one (작성) stopped: ① and ② still wait for 조사, which is not stopped → they spin; ③ still (any stopped)
    statusNow = () => ({ ...status('handed_over'), signals: { ...status('handed_over').signals, agents_ended: ended('m2') } });
    await tick(2_000);
    expect(paused()).toEqual([false, false, true]);
    expect(container.querySelectorAll('ol .animate-spin').length).toBe(2);
  });

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
    expect(container.querySelector('[data-testid=setup-trust-hint]')?.textContent).toBe('Claude Code는 처음 켤 때 작업 폴더를 믿을지 물어요. 창 아래 «이 컴퓨터의 에이전트» 줄에서 그 에이전트를 눌러 터미널을 열고, 화살표 키로 ❯를 «Yes, I trust this folder»에 맞춘 뒤 Enter를 눌러 주세요 — «No, exit»에서 Enter면 에이전트가 꺼져요.');
    expect(container.querySelectorAll('ol > li').length).toBe(3); // the note is inside ②'s item: still three steps for a screen reader

    statusNow = () => status('handed_over', { tools_connected: [{ member_id: 'm1', at: 'x' }, { member_id: 'm2', at: 'x' }], workdir_fallback_at: 'x' });
    await tick(2_000);
    expect(text()).toContain('에이전트를 준비했어요');
    expect(text()).toContain('조사 · Claude Code, 작성 · Codex');
    expect(container.querySelector('[data-testid=setup-trust-hint]')).toBeNull();
    expect(container.querySelectorAll('ol > li').length).toBe(3); // the folder note is inside ①'s item
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

describe('[SID:4427] (나) no organization yet — «시작» also makes the organization (design doc 9a4cb445 · Yuna f6cfda19 v2)', () => {
  const INVITE = { invite_id: 'i-1', org_id: 'o-9', org_name: '뭉클랩', role: 'admin', invited_at: '2026-09-29T00:00:00Z', expires_at: `${new Date().getFullYear()}-10-06T12:00:00Z` }; // this year, midday UTC (any runner time zone keeps the day)
  let invitesNow: () => Response;
  let meName: string | null;
  let confirmNow: () => Response;
  /** What POST /api/auth/refresh answers now (4429 ①: the new token that carries the new organization). */
  let refreshNow: () => Response | Promise<Response>;
  function stubNoOrg() {
    calls = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith('/api/invites/mine')) return invitesNow();
      if (url.endsWith('/api/auth/me')) return new Response(JSON.stringify({ data: { display_name: meName } }), { status: 200 });
      if (url.endsWith('/api/desktop/recipes/for-new-org')) return recipesNow();
      if (url.endsWith('/api/desktop/recipes')) return new Response('{"data":null,"error":{"code":"org_id_required"}}', { status: 400 });
      if (url.endsWith('/api/desktop/setup-codes/confirm-new-org')) return confirmNow();
      if (url.endsWith('/api/auth/refresh')) return refreshNow();
      if (url.endsWith('/api/current-project')) return new Response('{}', { status: 200 });
      if (url.includes('/api/desktop/setups/')) return new Response(JSON.stringify(statusNow()), { status: 200 });
      return new Response('{}', { status: 404 });
    }));
  }
  async function mountNoOrg(node: React.ReactNode) {
    ctx.mockReturnValue({ projectId: null, currentProjectSlug: null, userName: undefined, orgId: null, orgMemberships: [] });
    await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>); });
    for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); });
  }
  const urls = () => calls.map((c) => c.url);
  const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined;
  const flush = async () => { for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); }); };

  beforeEach(() => {
    invitesNow = () => new Response(JSON.stringify({ invites: [] }), { status: 200 });
    meName = '김지우';
    confirmNow = () => new Response(JSON.stringify({ setup_id: 's-1', members: [], work_item_id: 'w-1', org_id: 'o-new', project_id: 'p-new' }), { status: 200 });
    refreshNow = () => new Response('{}', { status: 200 });
  });

  it('no invites → one line «새 조직 «김지우의 조직»도 함께 만들어요» above the recipes; the list comes from the new-organization path; no «admin 아님»', async () => {
    stubNoOrg();
    await mountNoOrg(<DesktopSetup code={CODE} runtimes={['claude']} />);
    const line = container.querySelector('[data-testid=setup-new-org]')!;
    expect(line.textContent).toContain('새 조직 «김지우의 조직»도 함께 만들어요');
    expect(line.textContent).not.toContain('이름은 나중에'); // only once the fields are open
    expect(urls()).toContain('/api/desktop/recipes/for-new-org');
    expect(urls()).not.toContain('/api/desktop/recipes');
    expect(text()).not.toContain('조직 관리자만');
    // the line sits above the recipe choice
    const recipeSection = container.querySelector('[aria-labelledby=setup-recipe]')!;
    expect(line.compareDocumentPosition(recipeSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(startButton().disabled).toBe(false);
  });

  it('«시작» = one confirm-new-org with the names and no organization or project id; then refresh → current project → refresh → progress', async () => {
    stubNoOrg();
    await mountNoOrg(<DesktopSetup code={CODE} runtimes={['claude']} setupId="s-1" />);
    calls = [];
    await act(async () => { startButton().click(); });
    await flush();
    const sent = calls.filter((c) => c.url.includes('/api/desktop/setup-codes/'));
    expect(sent.map((c) => c.url)).toEqual(['/api/desktop/setup-codes/confirm-new-org']);
    expect(sent[0]!.body).toEqual({
      code: CODE, recipe_id: 'rec-1', roles: [{ role: '조사', runtime: 'claude' }, { role: '작성', runtime: 'claude' }],
      workdir_hint: '~/Sprintable/마케팅 루프', org_name: '김지우의 조직', project_name: '첫 프로젝트',
    });
    expect(calls.filter((c) => !c.url.includes('/api/desktop/setups/')).map((c) => c.url)).toEqual([
      '/api/desktop/setup-codes/confirm-new-org', '/api/auth/refresh', '/api/current-project', '/api/auth/refresh',
    ]);
    expect(calls.find((c) => c.url === '/api/current-project')!.body).toEqual({ project_id: 'p-new' });
    expect(container.textContent).not.toContain('새 조직 «'); // the progress view
  });

  it('[바꾸기] opens both names (organization · first project) with «이름은 나중에 설정에서 바꿀 수 있어요.»; an empty name blocks «시작» with its reason; typed names are sent', async () => {
    stubNoOrg();
    await mountNoOrg(<DesktopSetup code={CODE} runtimes={['claude']} />);
    await act(async () => { button('바꾸기')!.click(); });
    const section = container.querySelector('[data-testid=setup-new-org]')!;
    const [org, project] = [...section.querySelectorAll('input')] as HTMLInputElement[];
    expect([org!.value, project!.value]).toEqual(['김지우의 조직', '첫 프로젝트']);
    expect(section.textContent).toContain('이름은 나중에 설정에서 바꿀 수 있어요.');
    const type = async (el: HTMLInputElement, v: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    await type(org!, '  ');
    expect(startButton().disabled).toBe(true);
    expect(section.textContent).toContain('조직 이름을 적어 주세요');
    await type(org!, '우리 팀');
    await type(project!, '');
    expect(startButton().disabled).toBe(true);
    expect(section.textContent).toContain('프로젝트 이름을 적어 주세요');
    await type(project!, '출시');
    expect(startButton().disabled).toBe(false);
    await act(async () => { startButton().click(); });
    await flush();
    const body = calls.find((c) => c.url.endsWith('/confirm-new-org'))!.body as { org_name: string; project_name: string };
    expect([body.org_name, body.project_name]).toEqual(['우리 팀', '출시']);
  });

  it('default name: over 40 characters or no display name → «내 조직» (never the e-mail)', async () => {
    meName = '가'.repeat(41);
    stubNoOrg();
    await mountNoOrg(<DesktopSetup code={CODE} runtimes={['claude']} />);
    expect(container.querySelector('[data-testid=setup-new-org]')!.textContent).toContain('새 조직 «내 조직»도 함께 만들어요');
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    meName = null;
    stubNoOrg();
    await mountNoOrg(<DesktopSetup code={CODE} runtimes={['claude']} />);
    expect(container.querySelector('[data-testid=setup-new-org]')!.textContent).toContain('새 조직 «내 조직»도 함께 만들어요');
  });

  it('invited → the invite card instead of the form: who · as what · until when; no recipe read, no «시작», no button', async () => {
    invitesNow = () => new Response(JSON.stringify({ invites: [INVITE, { ...INVITE, invite_id: 'i-2', org_name: '다른 팀', role: 'member' }] }), { status: 200 });
    stubNoOrg();
    await mountNoOrg(<DesktopSetup code={CODE} runtimes={['claude']} />);
    const card = container.querySelector('[data-testid=setup-invited]')!;
    expect(card.textContent).toContain('초대받은 조직이 있어요');
    expect(card.textContent).toContain('뭉클랩에서 관리자로 초대했어요 · 10월 6일까지'); // this year: no year (Yuna 02:46Z)
    expect(card.textContent).toContain('다른 팀에서 멤버로 초대했어요');
    expect(card.textContent).toContain('초대 메일의 링크로 들어가면 그 조직에서 바로 시작할 수 있어요.');
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(urls().some((u) => u.includes('/api/desktop/recipes'))).toBe(false);
  });

  it('invite dates: month name + day, the year only when it is not this year (Yuna 02:46Z)', () => {
    const now = new Date('2026-09-30T03:00:00Z');
    expect(inviteUntilDate('2026-10-06T12:00:00Z', 'ko', now)).toBe('10월 6일');
    expect(inviteUntilDate('2026-10-06T12:00:00Z', 'en', now)).toBe('Oct 6');
    expect(inviteUntilDate('2027-01-06T12:00:00Z', 'ko', now)).toBe('2027년 1월 6일');
    expect(inviteUntilDate('2027-01-06T12:00:00Z', 'en', now)).toBe('Jan 6, 2027');
  });

  it('the invite read fails → sent to the one-screen «조직 만들기» ((가) · /onboarding?next=%2Fdesktop%2Fsetup) — not knowing is not «no invites»', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign } as unknown as Location);
    invitesNow = () => new Response('{}', { status: 503 });
    stubNoOrg();
    await mountNoOrg(<DesktopSetup code={CODE} runtimes={['claude']} />);
    expect(assign).toHaveBeenCalledWith('/onboarding?next=%2Fdesktop%2Fsetup');
    expect(urls().some((u) => u.includes('/api/desktop/recipes'))).toBe(false);
    expect(container.querySelector('[data-testid=setup-new-org]')).toBeNull();
  });

  it('refusals: an invite arrived meanwhile (409 pending_invites) → the invite card · an organization appeared (409 has_organization) → «이미 조직이 있어요» [다시 불러오기] · e-mail not verified · organization limit → the one-screen words', async () => {
    // [confirm's answer, what the invite read says afterwards, what the page then says]
    const cases: [Response, unknown[], (t: string) => void][] = [
      [new Response(JSON.stringify({ data: null, error: { code: 'pending_invites' } }), { status: 409 }), [INVITE], (t) => expect(t).toContain('초대받은 조직이 있어요')],
      [new Response(JSON.stringify({ data: null, error: { code: 'has_organization' } }), { status: 409 }), [], (t) => { expect(t).toContain('이미 조직이 있어요'); expect(button('다시 불러오기')).toBeTruthy(); }],
      [new Response(JSON.stringify({ data: null, error: { code: 'EMAIL_VERIFICATION_REQUIRED' } }), { status: 403 }), [], (t) => expect(t).toContain('이메일 인증이 필요해요')],
      [new Response(JSON.stringify({ data: null, error: { code: 'PLAN_LIMIT_EXCEEDED', resource: 'org', limit: 1 } }), { status: 402 }), [], (t) => expect(t).toContain('조직을 1개까지')],
      [new Response(JSON.stringify({ data: null, error: { code: 'code_expired' } }), { status: 410 }), [], (t) => expect(t).toContain('설정 시간이 지났어요')],
    ];
    for (const [answer, invitesAfter, check] of cases) {
      invitesNow = () => new Response(JSON.stringify({ invites: [] }), { status: 200 });
      confirmNow = () => answer;
      stubNoOrg();
      await mountNoOrg(<DesktopSetup code={CODE} runtimes={['claude']} />);
      invitesNow = () => new Response(JSON.stringify({ invites: invitesAfter }), { status: 200 });
      await act(async () => { startButton().click(); });
      await flush();
      check(text());
      await act(async () => { root.unmount(); });
      root = createRoot(container);
    }
  });

  it('4429 ④: 409 pending_invites but the invites read again come back empty → not stuck on «시작 중»: the choice comes back and «시작» works again', async () => {
    confirmNow = () => new Response(JSON.stringify({ data: null, error: { code: 'pending_invites' } }), { status: 409 });
    stubNoOrg();
    await mountNoOrg(<DesktopSetup code={CODE} runtimes={['claude']} />);
    await act(async () => { startButton().click(); });
    await flush();
    // the invite was withdrawn meanwhile: the new-organization choice again, not a spinner that never ends
    expect(container.querySelector('[data-testid=setup-invited]')).toBeNull();
    expect(startButton()).toBeTruthy();
    expect(startButton().disabled).toBe(false);
    expect(container.querySelector('[data-testid=setup-new-org]')).not.toBeNull();
  });

  it('4429 ②: «이미 조직이 있어요» [다시 불러오기] reloads WITH the setup values in the fragment (they are only in memory — a bare reload lost them and showed «앱에서 열기»)', async () => {
    const order: string[] = [];
    const reload = vi.fn(() => { order.push('reload'); });
    vi.stubGlobal('location', { ...window.location, pathname: '/desktop/setup', search: '', hash: '', reload } as unknown as Location);
    let replaced = '';
    const replaceState = vi.spyOn(window.history, 'replaceState').mockImplementation((_s, _t, url) => { replaced = String(url); order.push('replace'); });
    confirmNow = () => new Response(JSON.stringify({ data: null, error: { code: 'has_organization' } }), { status: 409 });
    stubNoOrg();
    await mountNoOrg(<DesktopSetup code={CODE} runtimes={['claude', 'codex']} setupId="s-1" blocked={['codex']} />);
    await act(async () => { startButton().click(); });
    await flush();
    await act(async () => { button('다시 불러오기')!.click(); });
    expect(order).toEqual(['replace', 'reload']); // the values go back into the address first, then the reload
    expect(replaced.startsWith('/desktop/setup#')).toBe(true);
    expect(replaced).not.toMatch(/\?.*code=/); // only in the fragment, never a query
    const q = new URLSearchParams(replaced.split('#')[1]);
    expect([q.get('code'), q.get('setup'), q.get('runtimes'), q.get('blocked')]).toEqual([CODE, 's-1', 'claude,codex', 'codex']);
    replaceState.mockRestore();
  });

  it('4429 ③: 429 RATE_LIMITED → «잠깐 사이에 너무 자주 시도했어요. {time} 뒤에 다시 «시작»을 눌러 주세요.» in the error line\'s place, «시작» left on (Yuna f6cfda19 v5)', async () => {
    const cases: [Record<string, string>, string][] = [
      [{ 'Retry-After': '30' }, '30초'], [{ 'Retry-After': '61' }, '2분'], [{}, '잠시'],
    ];
    for (const [headers, time] of cases) {
      confirmNow = () => new Response(JSON.stringify({ data: null, error: { code: 'RATE_LIMITED', message: 'Too many requests' } }), { status: 429, headers });
      stubNoOrg();
      await mountNoOrg(<DesktopSetup code={CODE} runtimes={['claude']} />);
      await act(async () => { startButton().click(); });
      await flush();
      expect(container.querySelector('[data-testid=setup-rate-limited]')?.textContent).toBe(`잠깐 사이에 너무 자주 시도했어요. ${time} 뒤에 다시 «시작»을 눌러 주세요.`);
      expect(startButton().disabled).toBe(false); // trying again is true
      expect(text()).not.toContain('잠시 뒤 다시 시도해 주세요');
      await act(async () => { root.unmount(); });
      root = createRoot(container);
    }
  });

  // a 401 here goes through fetchWithAuth's own session-expired flow (one refresh, then the global «다시 로그인» dialog) — the
  // app-wide answer for a dead session; this card is for the answers that flow does not take: 5xx and offline
  it('4429 ①: the new token could not be had (5xx · offline, each after one retry) → «설정을 마쳤어요» with [다시 불러오기] instead of a progress view it cannot read', async () => {
    const answers: [string, () => Response | Promise<Response>][] = [
      ['500', () => new Response('{"data":null,"error":{"code":"internal"}}', { status: 500 })],
      ['503', () => new Response('{"data":null,"error":{"code":"UPSTREAM_UNREACHABLE"}}', { status: 503 })],
      ['offline', () => Promise.reject(new TypeError('Failed to fetch'))],
    ];
    for (const [name, answer] of answers) {
      refreshNow = answer;
      stubNoOrg();
      await mountNoOrg(<DesktopSetup code={CODE} runtimes={['claude']} setupId="s-1" />);
      await act(async () => { startButton().click(); });
      await flush();
      expect(text(), name).toContain('설정을 마쳤어요');
      expect(text(), name).toContain('에이전트는 이 컴퓨터에서 시작돼요. 진행 상황을 보려면 이 페이지를 다시 불러와 주세요.');
      expect(text(), name).not.toContain('앱이 받아 가기를 기다리는 중'); // not a progress it cannot read
      expect(calls.filter((c) => c.url.endsWith('/api/auth/refresh')).length, name).toBeGreaterThanOrEqual(2); // one retry
      expect([...container.querySelectorAll('button')].map((b) => b.textContent), name).toEqual(['다시 불러오기']);
      await act(async () => { root.unmount(); });
      root = createRoot(container);
    }
  });

  it('4429 ①: a first refresh that fails and a retry that works → the progress view as usual', async () => {
    let n = 0;
    refreshNow = () => (++n === 1 ? new Response('{}', { status: 503 }) : new Response('{}', { status: 200 }));
    stubNoOrg();
    await mountNoOrg(<DesktopSetup code={CODE} runtimes={['claude']} setupId="s-1" />);
    await act(async () => { startButton().click(); });
    await flush(); await flush();
    expect(text()).not.toContain('설정을 마쳤어요');
    expect(calls.filter((c) => c.url.endsWith('/api/auth/refresh')).length).toBe(3); // 503 · retry ok · the second renewal ok
    // the progress's first read is on the next task (setTimeout 0): wait for it as a condition
    await vi.waitFor(() => expect(calls.some((c) => c.url.includes('/api/desktop/setups/s-1'))).toBe(true));
  });

  it('4429 ①: [다시 불러오기] reloads to the progress of THIS setup (#progress=<setup id> — no code), and that page renews the token first', async () => {
    refreshNow = () => new Response('{}', { status: 503 });
    stubNoOrg();
    await mountNoOrg(<DesktopSetup code={CODE} runtimes={['claude']} setupId="s-1" />);
    await act(async () => { startButton().click(); });
    await flush();
    const order: string[] = []; let replaced = '';
    vi.stubGlobal('location', { ...window.location, pathname: '/desktop/setup', search: '', hash: '', reload: vi.fn(() => { order.push('reload'); }) } as unknown as Location);
    const replaceState = vi.spyOn(window.history, 'replaceState').mockImplementation((_s, _t, url) => { replaced = String(url); order.push('replace'); });
    await act(async () => { button('다시 불러오기')!.click(); });
    expect(order).toEqual(['replace', 'reload']);
    expect(replaced).toBe('/desktop/setup#progress=s-1');
    expect(replaced).not.toContain(CODE);
    replaceState.mockRestore();
  });

  it('4429 ①: the page opened at #progress=<setup id> renews the token, then shows that setup\'s progress — or the same card again if it still cannot', async () => {
    for (const [ok, expectCard] of [[true, false], [false, true]] as const) {
      refreshNow = () => (ok ? new Response('{}', { status: 200 }) : new Response('{}', { status: 503 }));
      stubNoOrg();
      window.location.hash = '#progress=s-9';
      await mountNoOrg(<DesktopSetupEntry />);
      await flush();
      expect(window.location.hash, 'taken off the address').toBe('');
      expect(calls.some((c) => c.url.endsWith('/api/auth/refresh'))).toBe(true);
      expect(text().includes('설정을 마쳤어요'), `ok=${ok}`).toBe(expectCard);
      expect(text()).not.toContain('데스크톱 앱에서 열어 주세요'); // never the «open in the app» card for this address
      if (ok) await vi.waitFor(() => expect(calls.some((c) => c.url.includes('/api/desktop/setups/s-9'))).toBe(true));
      else expect(calls.some((c) => c.url.includes('/api/desktop/setups/s-9'))).toBe(false);
      await act(async () => { root.unmount(); });
      root = createRoot(container);
    }
    // the same when #progress arrives after the page is up (a same-document change — the path the app's reopen takes too)
    refreshNow = () => new Response('{}', { status: 200 });
    stubNoOrg();
    window.location.hash = '';
    await mountNoOrg(<DesktopSetupEntry />);
    await setHash('#progress=s-8');
    await flush();
    expect(window.location.hash).toBe('');
    await vi.waitFor(() => expect(calls.some((c) => c.url.includes('/api/desktop/setups/s-8'))).toBe(true));
    expect(text()).not.toContain('데스크톱 앱에서 열어 주세요');
  });

  it('with an organization the page never asks for invites and reads the usual list', async () => {
    stub(() => new Response('{}', { status: 200 }));
    await mount(<DesktopSetup code={CODE} runtimes={['claude']} />);
    expect(calls.map((c) => c.url)).not.toContain('/api/invites/mine');
    expect(calls.map((c) => c.url)).toContain('/api/desktop/recipes');
    expect(container.querySelector('[data-testid=setup-new-org]')).toBeNull();
  });
});
