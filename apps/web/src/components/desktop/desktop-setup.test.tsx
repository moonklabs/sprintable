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
import { markDesktopSetupLogin } from '@/lib/desktop-setup';

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

function stub(confirm: () => Response | Promise<Response>) {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith('/api/events/definitions')) return new Response(JSON.stringify({ data: RECIPES }), { status: 200 });
    if (url.includes('/api/desktop/setup-codes/')) return confirm();
    return new Response('{}', { status: 404 });
  }));
}

async function mount(node: React.ReactNode, role = 'owner') {
  ctx.mockReturnValue({ projectId: 'p-1', userName: '김지우', orgId: 'o-1', orgMemberships: [{ orgId: 'o-1', orgName: 'O', orgSlug: 'o', role }] });
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
    expect(text()).toContain('에이전트에 Sprintable이 연결되지 않았어요');
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

  it('4426 + login round trip: the values carried by the login page are used once, and desktop_setup_signed_in goes with the setup id', async () => {
    stub(() => new Response('{}'));
    window.history.replaceState(null, '', '/desktop/setup'); // the login page sent us back without the #
    markDesktopSetupLogin('/desktop/setup', `#code=${CODE}&setup=s-1&runtimes=claude`);
    await mount(<DesktopSetupEntry />);
    expect(text()).toContain('에이전트를 이 컴퓨터에서 시작해요');
    expect(events().map((e) => [e.event, e.session_id])).toEqual([['desktop_setup_signed_in', 's-1']]);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(CODE); // taken: nothing left in storage
    await act(async () => { root.unmount(); }); root = createRoot(container);
    stub(() => new Response('{}'));
    window.history.replaceState(null, '', `/desktop/setup#code=${CODE}&setup=s-1&runtimes=claude`);
    await mount(<DesktopSetupEntry />); // no login this time
    expect(events()).toEqual([]);
  });

  it('4426 · AC2: while a setup runs in this tab, opening a guide link sends desktop_doc_opened; other links and other tabs send nothing', async () => {
    stub(() => new Response('{}'));
    await mount(<><DesktopSetup code={CODE} runtimes={['claude']} setupId="s-2" /><DesktopSetupDocWatch /><a href="https://sprintable.ai/ko/blog/desktop" onClick={(e) => e.preventDefault()}>guide</a><a href="/kanban" onClick={(e) => e.preventDefault()}>board</a></>);
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
