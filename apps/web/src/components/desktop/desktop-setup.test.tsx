// @vitest-environment jsdom
//
// story #4427 — 웹 설정 페이지: 기본값이 채워진 채 열림 · «시작» 한 번 = confirm 하나 · 실패 갈래 · 코드 없이 온 경우.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const { ctx } = vi.hoisted(() => ({ ctx: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ctx() }));

import { DesktopSetup, DesktopSetupEntry, OpenInDesktopApp, SETUP_APP_LINK, ToolsNotConnected, failureForCode } from './desktop-setup';
import { DesktopSetupDocWatch } from './desktop-setup-doc-watch';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CODE = `${'A'.repeat(20)}_-${'b'.repeat(21)}`;
const RECIPES = [
  {
    id: 'rec-1', key: 'org.marketing_loop', org_id: 'o-1', name: '마케팅 루프', description: '글감을 모으고 초안을 써요', enabled: true,
    payload_schema: { properties: { stage: { enum: ['research', 'draft', 'review', 'publish'] } } },
    stage_metadata: {
      research: { role: '조사' }, draft: { role: '작성' },
      review: { role: '연출', gate: { type: 'approval', approver: 'org_owner' } },
      publish: { role: '발행', capability: { kind: 'publish', target: 'channel_connection' } },
    },
    role_actor_kinds: { 조사: 'agent', 작성: 'either', 연출: 'human' },
  },
  { id: 'rec-2', key: 'org.research_one', org_id: 'o-1', name: '조사 한 명', enabled: true, payload_schema: { properties: { stage: { enum: ['research'] } } }, stage_metadata: { research: { role: '조사' } }, role_actor_kinds: { 조사: 'agent' } },
];

let container: HTMLDivElement;
let root: Root;
let calls: { url: string; body?: unknown }[];
/** What GET /api/desktop/setups/{id} answers now (the progress tests change it between polls). */
let statusNow: () => unknown = () => ({});

function stub(confirm: () => Response | Promise<Response>) {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith('/api/events/definitions')) return new Response(JSON.stringify({ data: RECIPES }), { status: 200 });
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
const startButton = () => [...container.querySelectorAll('button')].find((b) => b.textContent === '시작') as HTMLButtonElement;

beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
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
    expect(text()).toContain('npm install -g @anthropic-ai/claude-code');
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
    expect(text()).toContain('터미널에서 작업 폴더를 믿을지 묻고 있다면 먼저 답해 주세요');
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
