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

import { DesktopSetup, OpenInDesktopApp, SETUP_APP_LINK, failureForCode } from './desktop-setup';

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
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

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

  it('«시작» = one confirm with {stage, runtime} for agent rows and the folder hint — nothing else is called', async () => {
    stub(() => new Response(JSON.stringify({ data: { work_item_id: 'w-1' } }), { status: 200 }));
    await mount(<DesktopSetup code={CODE} runtimes={['claude', 'codex']} />);
    await act(async () => { startButton().click(); });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    const posts = calls.filter((c) => c.body !== undefined);
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toContain(`/api/desktop/setup-codes/${CODE}/confirm`);
    expect(posts[0].body).toEqual({ project_id: 'p-1', recipe_id: 'rec-1', roles: [{ stage: 'research', runtime: 'claude' }, { stage: 'draft', runtime: 'claude' }], workdir_hint: '~/Sprintable/마케팅 루프' });
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

  it('opened without a code (a browser, AC5): «데스크톱 앱에서 열어 주세요» with «앱 열기»', async () => {
    stub(() => new Response('{}'));
    await mount(<OpenInDesktopApp />);
    expect(text()).toContain('데스크톱 앱에서 열어 주세요');
    expect((container.querySelector(`a[href="${SETUP_APP_LINK}"]`) as HTMLAnchorElement).textContent).toBe('앱 열기');
  });
});
