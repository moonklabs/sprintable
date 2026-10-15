// @vitest-environment jsdom
//
// [SID:4680] (Yuna §N · PO 10-15 walk 0-5): the recruiter meeting the plan's agent limit. POST /api/agents answering 402 PLAN_LIMIT_EXCEEDED · resource agent says
// it in the project-limit family's words (banner title · one reason line · the upgrade way) — in BOTH roads (the key-only «equip» road and the full recruit road);
// every other failure keeps «채용 처리에 실패했어요. 다시 시도해 주세요.». Real mounts, the way the neighbouring recruiter tests do (source regexes cannot say
// whether the branch ran). next-intl is the same key-echo mock they use, so the keys (not the words) are pinned here; the words are pinned against the messages files below.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import koMessages from '../../../../../../messages/ko.json';
import enMessages from '../../../../../../messages/en.json';
import { RecruiterClient } from './recruiter-client';

vi.mock('next-intl', () => ({
  useTranslations: (ns: string) => {
    const t = (key: string, vars?: Record<string, unknown>) => (vars ? `${ns}.${key}(${JSON.stringify(vars)})` : `${ns}.${key}`);
    t.rich = (key: string) => `${ns}.${key}`;
    t.markup = (key: string) => `${ns}.${key}`;
    t.raw = (key: string) => `${ns}.${key}`;
    t.has = () => true;
    return t;
  },
  useLocale: () => 'ko',
}));
vi.mock('@/app/onboarding/onboarding-telemetry', () => ({ emitOnboardingEvent: vi.fn(), beaconOnboardingEvent: vi.fn() }));

const json = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;
const ROLE = { id: 'role-1', slug: 'backend', name: 'Backend Engineer', category: 'engineering', description: 'desc', default_tool_groups: ['stories', 'tasks'] };
const limit402 = (over: Record<string, unknown> = {}) => json({ error: { code: 'PLAN_LIMIT_EXCEEDED', resource: 'agent', limit: 3, current: 3, tier: 'free', upgrade_required: true, message: 'free plan agent limit (3/3) reached.', ...over } }, 402);

let container: HTMLDivElement;
let root: Root;
let createAnswer: Response;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_EE_ENABLED', 'true'); // billing open unless a test says otherwise (the closed road has its own describe)
  container = document.createElement('div');
  document.body.appendChild(container);
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    if (url.startsWith('/api/role-templates')) return json({ data: [ROLE] });
    if (url === '/api/projects') return json({ data: [{ id: 'proj-1', name: 'Proj 1' }] });
    if (url === '/api/runtime-capabilities') return json({ data: [] });
    if (url.startsWith('/api/team-members?')) return json({ data: [] });
    if (url === '/api/agents' && method === 'POST') return createAnswer;
    throw new Error(`unmocked fetch: ${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const click = async (el: Element | undefined) => { expect(el).toBeTruthy(); await act(async () => { el!.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); };
const buttons = (text: string) => Array.from(container.querySelectorAll('button')).filter((b) => b.textContent === text);
const flush = async () => { await act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); }); };
const type = async (el: HTMLInputElement, v: string) => act(async () => {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
async function mount() {
  await act(async () => { root = createRoot(container); root.render(<RecruiterClient projectId="proj-1" showTopBar={false} />); });
  await flush();
}
/** the key-only road: «역할 없이(키만)» → 다음 → name → [생성] */
async function equipCreate(name = 'Limit Test Agent') {
  await mount();
  await click(Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('recruiter.equipSkipCardTitle')));
  await click(buttons('recruiter.next')[0]);
  await type(container.querySelector('input[type="text"]') as HTMLInputElement, name);
  await click(buttons('recruiter.equipCreateCta')[0]);
  await flush();
}
/** the full road: a role card → 다음 → «all projects» scope → 다음 → name → [채용] */
async function recruitCreate(name = 'Limit Test Agent') {
  await mount();
  await click(Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(ROLE.name)));
  await click(buttons('recruiter.next')[0]);
  await click(Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('settings.agentScopeAllProjects')));
  await click(buttons('recruiter.next')[0]);
  await type(container.querySelector('input[type="text"]') as HTMLInputElement, name);
  await click(buttons('recruiter.recruitCta')[0]);
  await flush();
}
const banner = () => container.querySelector('[data-testid="agent-limit-banner"]');
const GENERAL = 'recruiter.recruitFailed';

describe('[4680] the key-only («equip») road', () => {
  it('402 · agent · free · limit 3 → the banner: title · the free reason with 3 · the upgrade way (no «다시 시도», no general line)', async () => {
    createAnswer = limit402();
    await equipCreate();
    expect(banner()).not.toBeNull();
    expect(banner()!.getAttribute('role')).toBe('alert');
    expect(banner()!.textContent).toContain('nav.orgLimitBannerTitle');
    expect(banner()!.textContent).toContain('recruiter.agentLimitExceededError({"limit":3})');
    expect(banner()!.querySelector('a')?.textContent).toBe('nav.orgLimitUpgradeLink');
    expect(banner()!.querySelector('a')?.getAttribute('href')).toContain('/settings?tab=billing');
    expect(container.textContent).not.toContain(GENERAL);
    expect(container.textContent).not.toContain('recruiter.retry');
  });
  it('what was typed stays and the button is usable again', async () => {
    createAnswer = limit402();
    await equipCreate('Kept Name');
    expect((container.querySelector('input[type="text"]') as HTMLInputElement).value).toBe('Kept Name');
    expect((buttons('recruiter.equipCreateCta')[0] as HTMLButtonElement).disabled).toBe(false);
  });
  it('another tier → the paid line · no limit in the answer → the free line without a number (free) / no reason line (another tier)', async () => {
    createAnswer = limit402({ tier: 'starter' });
    await equipCreate();
    expect(banner()!.textContent).toContain('recruiter.agentLimitExceededPaid({"limit":3})');
  });
  it('no limit, free → «all made» line without a number', async () => {
    createAnswer = limit402({ limit: undefined });
    await equipCreate();
    expect(banner()!.textContent).toContain('recruiter.agentLimitExceededNoCount');
    expect(banner()!.textContent).not.toContain('limit');
  });
  it('no limit, another tier → title and the way only (no word was given for it · no number made up)', async () => {
    createAnswer = limit402({ limit: undefined, tier: 'team' });
    await equipCreate();
    expect(banner()!.textContent).toBe('nav.orgLimitBannerTitlenav.orgLimitUpgradeLink');
  });
  it('after the banner, a next attempt that fails otherwise: the banner goes and the old line comes (one at a time)', async () => {
    createAnswer = limit402();
    await equipCreate();
    expect(banner()).not.toBeNull();
    createAnswer = json({ error: { code: 'INTERNAL' } }, 500);
    await click(buttons('recruiter.equipCreateCta')[0]);
    await flush();
    expect(banner()).toBeNull();
    expect(container.textContent).toContain(GENERAL);
  });
  it('500 → the old line, no banner', async () => {
    createAnswer = json({ error: { code: 'INTERNAL' } }, 500);
    await equipCreate();
    expect(banner()).toBeNull();
    expect(container.textContent).toContain(GENERAL);
  });
  it('402 of another kind (project limit · another code) or a 403 with the agent-limit body → the old line, no banner', async () => {
    for (const answer of [limit402({ resource: 'project' }), limit402({ code: 'AU_PAUSED' }), json({ error: { code: 'PLAN_LIMIT_EXCEEDED', resource: 'agent' } }, 403)]) {
      createAnswer = answer;
      await equipCreate();
      expect(banner()).toBeNull();
      expect(container.textContent).toContain(GENERAL);
      act(() => root.unmount());
      container.innerHTML = '';
    }
  });
});

describe('[4680] the full recruit road', () => {
  it('402 · agent → the banner · the button frees · no second call (no recruit) · the typed name stays', async () => {
    createAnswer = limit402();
    await recruitCreate('Kept Name 2');
    expect(banner()).not.toBeNull();
    expect(banner()!.textContent).toContain('recruiter.agentLimitExceededError({"limit":3})');
    expect(container.textContent).not.toContain(GENERAL);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/recruit'))).toBe(false);
    expect((container.querySelector('input[type="text"]') as HTMLInputElement).value).toBe('Kept Name 2');
    expect((buttons('recruiter.recruitCta')[0] as HTMLButtonElement).disabled).toBe(false);
  });
  it('500 → the old line, no banner', async () => {
    createAnswer = json({ error: { code: 'INTERNAL' } }, 500);
    await recruitCreate();
    expect(banner()).toBeNull();
    expect(container.textContent).toContain(GENERAL);
  });
});

describe('[4680] billing closed (prod today · Yuna §N-2): the fact — title «한도에 도달했어요» key · the limit sentence only · no way', () => {
  beforeEach(() => { vi.stubEnv('NEXT_PUBLIC_EE_ENABLED', 'false'); });
  it('equip road · 402 free limit 3 → the closed banner: no link, no «upgrade» key, the closed sentence with 3; typed name stays', async () => {
    createAnswer = limit402();
    await equipCreate('Kept Closed');
    expect(banner()).not.toBeNull();
    expect(banner()!.textContent).toContain('nav.orgLimitBannerTitleClosed');
    expect(banner()!.textContent).toContain('recruiter.agentLimitExceededClosed({"limit":3})');
    expect(banner()!.textContent).not.toMatch(/nav\.orgLimitBannerTitle(?!Closed)/); // the open title is not there
    expect(banner()!.textContent).not.toContain('orgLimitUpgradeLink');
    expect(banner()!.textContent).not.toContain('agentLimitExceededError');
    expect(banner()!.querySelector('a')).toBeNull();
    expect(container.querySelector('a[href*="tab=billing"]')).toBeNull();
    expect(container.textContent).not.toContain(GENERAL);
    expect((container.querySelector('input[type="text"]') as HTMLInputElement).value).toBe('Kept Closed');
  });
  it('full recruit road · the same closed banner · no recruit call', async () => {
    createAnswer = limit402();
    await recruitCreate();
    expect(banner()!.textContent).toContain('nav.orgLimitBannerTitleClosed');
    expect(banner()!.textContent).toContain('recruiter.agentLimitExceededClosed({"limit":3})');
    expect(banner()!.querySelector('a')).toBeNull();
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/recruit'))).toBe(false);
  });
  it('no limit in the answer → the number-less closed sentence (free or another tier — no paid branch where billing is closed)', async () => {
    for (const tier of ['free', 'team']) {
      createAnswer = limit402({ limit: undefined, tier });
      await equipCreate();
      expect(banner()!.textContent).toContain('recruiter.agentLimitExceededNoCountClosed');
      expect(banner()!.querySelector('a')).toBeNull();
      act(() => root.unmount());
      container.innerHTML = '';
    }
  });
  it('limit 0 → «the free plan does not include agents» (closed sentence) — not «0개까지», not «모두 만들었어요»', async () => {
    createAnswer = limit402({ limit: 0 });
    await equipCreate();
    expect(banner()!.textContent).toContain('recruiter.agentLimitZeroClosed');
    expect(banner()!.textContent).not.toContain('"limit":0');
    expect(banner()!.textContent).not.toContain('NoCount');
  });
  it('another kind of failure is the old line here too', async () => {
    createAnswer = json({ error: { code: 'INTERNAL' } }, 500);
    await equipCreate();
    expect(banner()).toBeNull();
    expect(container.textContent).toContain(GENERAL);
  });
});

describe('[4680] billing open · limit 0 (Yuna §N-2): its own sentence + the old second sentence, the way drawn', () => {
  it('free · limit 0 → agentLimitZero (not the «…Error» with 0, not the number-less line)', async () => {
    createAnswer = limit402({ limit: 0 });
    await equipCreate();
    expect(banner()!.textContent).toContain('recruiter.agentLimitZero');
    expect(banner()!.textContent).not.toContain('agentLimitExceededError');
    expect(banner()!.textContent).not.toContain('agentLimitExceededNoCount');
    expect(banner()!.querySelector('a')?.getAttribute('href')).toContain('/settings?tab=billing');
  });
});

describe('[4680] the words (Yuna §N) are the messages', () => {
  const rec = (m: unknown) => (m as { recruiter: Record<string, string> }).recruiter;
  it('ko · en: the three lines are exactly the ones in the copy file', () => {
    expect(rec(koMessages).agentLimitExceededError).toBe('무료 플랜은 에이전트를 {limit}개까지 만들 수 있어요. 계속하려면 요금제를 업그레이드해 주세요.');
    expect(rec(koMessages).agentLimitExceededPaid).toBe('지금 요금제는 에이전트를 {limit}개까지 만들 수 있어요. 더 만들려면 요금제를 바꿔 주세요.');
    expect(rec(koMessages).agentLimitExceededNoCount).toBe('무료 플랜에서 만들 수 있는 에이전트를 모두 만들었어요. 계속하려면 요금제를 업그레이드해 주세요.');
    expect(rec(enMessages).agentLimitExceededError).toBe('The free plan allows up to {limit} agent(s). Upgrade your plan to continue.');
    expect(rec(enMessages).agentLimitExceededPaid).toBe('Your current plan allows up to {limit} agent(s). Change your plan to add more.');
    expect(rec(enMessages).agentLimitExceededNoCount).toBe("You've reached the free plan's agent limit. Upgrade your plan to continue.");
  });
  it('the title and the way are the existing nav keys (not new words)', () => {
    const nav = (m: unknown) => (m as { nav: Record<string, string> }).nav;
    expect(nav(koMessages).orgLimitBannerTitle).toBe('업그레이드가 필요해요');
    expect(nav(koMessages).orgLimitUpgradeLink).toBe('요금제 업그레이드 →');
    expect(nav(enMessages).orgLimitBannerTitle).toBeTruthy();
    expect(nav(enMessages).orgLimitUpgradeLink).toBeTruthy();
  });
});
