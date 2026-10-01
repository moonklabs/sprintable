// @vitest-environment jsdom
// story 4427 — desktop sign-up: one screen «조직 만들기» (Yuna f6cfda19), defaults filled, one «만들기», back to the setup page.
import { EmailVerifyGate } from '@/components/auth/email-verify-gate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { DesktopCreateOrg, defaultOrgName } from './desktop-create-org';
import OnboardingPage from './page';
import { OnboardingForm } from './onboarding-form';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let hrefSet: string[];

type Call = { url: string; body: Record<string, unknown> | null };
function stubFetch(opts: { displayName?: string | null; projectFailsOnce?: boolean; meDelay?: Promise<void> } = {}) {
  const calls: Call[] = [];
  let projectFails = opts.projectFailsOnce ?? false;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    const ok = (data: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ data, error: null, meta: null }) } as Response);
    if (url === '/api/auth/me') { if (opts.meDelay) await opts.meDelay; return ok({ member_id: 'u1', display_name: opts.displayName ?? null }); }
    if (url === '/api/organizations') return ok({ id: 'org-1', name: 'x', slug: 'workspace-abc' });
    if (url === '/api/projects') {
      if (projectFails) { projectFails = false; return { ok: false, status: 500, headers: new Headers(), json: async () => ({ data: null, error: { code: 'X' } }) } as Response; }
      return ok({ id: 'proj-1', name: 'y' });
    }
    if (url === '/api/current-project' || url === '/api/auth/refresh') return ok({});
    throw new Error('unexpected fetch: ' + url);
  }));
  return calls;
}

function wrap(locale: 'ko' | 'en' = 'ko') {
  return (
    <NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul">
      <DesktopCreateOrg next="/desktop/setup" />
    </NextIntlClientProvider>
  );
}

const inputs = () => Array.from(container.querySelectorAll('input')) as HTMLInputElement[];
const createButton = () => Array.from(container.querySelectorAll('button')).find((b) => /만들기|만드는 중|Create/.test(b.textContent ?? '')) as HTMLButtonElement;
const settle = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
async function type(input: HTMLInputElement, value: string) {
  const setNative = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => { setNative.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  hrefSet = [];
  vi.stubGlobal('location', { ...window.location, set href(v: string) { hrefSet.push(v); }, get href() { return 'http://localhost/onboarding'; } });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

describe('defaultOrgName (Yuna f6cfda19 copy table)', () => {
  const withName = (n: string) => `${n}의 조직`;
  it('uses the profile display name, «내 조직» without one or when it is longer than 40', () => {
    expect(defaultOrgName('김지우', withName, '내 조직')).toBe('김지우의 조직');
    expect(defaultOrgName('  ', withName, '내 조직')).toBe('내 조직');
    expect(defaultOrgName(null, withName, '내 조직')).toBe('내 조직');
    expect(defaultOrgName('x'.repeat(41), withName, '내 조직')).toBe('내 조직');
    expect(defaultOrgName('x'.repeat(40), withName, '내 조직')).toBe(`${'x'.repeat(40)}의 조직`);
  });
});

describe('DesktopCreateOrg', () => {
  it('shows one screen with both names filled — organization from the display name, «첫 프로젝트» — no slug field, no agent step', async () => {
    stubFetch({ displayName: '김지우' });
    await act(async () => { root.render(wrap()); });
    await settle();
    expect(container.textContent).toContain('조직 만들기');
    expect(container.textContent).toContain('이 컴퓨터에서 시작하기');
    expect(inputs().map((i) => i.value)).toEqual(['김지우의 조직', '첫 프로젝트']);
    expect(container.textContent).toContain('초대받은 조직이 있다면');
    expect(container.textContent).not.toMatch(/slug|주소|에이전트 만들기|Create Agent/i);
  });

  it('never uses the e-mail: no display name → «내 조직»; a name the person already typed is not replaced when /auth/me answers late', async () => {
    let release!: () => void;
    stubFetch({ displayName: '김지우', meDelay: new Promise<void>((r) => { release = r; }) });
    await act(async () => { root.render(wrap()); });
    expect(inputs()[0].value).toBe('내 조직');
    await type(inputs()[0], '우리 팀');
    await act(async () => { release(); });
    await settle();
    expect(inputs()[0].value).toBe('우리 팀');
  });

  it('one «만들기»: creates the organization without a slug, refreshes, creates the project, sets it current, refreshes, goes back to next', async () => {
    const calls = stubFetch({ displayName: '김지우' });
    await act(async () => { root.render(wrap()); });
    await settle();
    await act(async () => { createButton().click(); });
    await settle();
    const seq = calls.map((c) => c.url).filter((u) => u !== '/api/auth/me');
    expect(seq).toEqual(['/api/organizations', '/api/auth/refresh', '/api/projects', '/api/current-project', '/api/auth/refresh']);
    const org = calls.find((c) => c.url === '/api/organizations')!.body!;
    expect(org).toEqual({ name: '김지우의 조직' });
    expect('slug' in org).toBe(false);
    expect(calls.find((c) => c.url === '/api/projects')!.body).toMatchObject({ org_id: 'org-1', name: '첫 프로젝트' });
    expect(hrefSet).toEqual(['/desktop/setup?p=proj-1']);
  });

  it('a failed project keeps the organization: the retry makes only the project (never a second organization)', async () => {
    const calls = stubFetch({ projectFailsOnce: true });
    await act(async () => { root.render(wrap()); });
    await settle();
    await act(async () => { createButton().click(); });
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toBeTruthy();
    expect(hrefSet).toEqual([]);
    // Yuna ⑥ (PO 01:38Z): on this panel only, the alert says why the organization field is locked and the button says what a retry does
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('조직은 만들었어요 — 다시 누르면 프로젝트만 만들어요.');
    expect(createButton().textContent).toBe('프로젝트 만들기');
    expect((container.querySelector('#desktop-org-name') as HTMLInputElement).disabled).toBe(true);
    await act(async () => { createButton().click(); });
    await settle();
    expect(calls.filter((c) => c.url === '/api/organizations')).toHaveLength(1);
    expect(calls.filter((c) => c.url === '/api/projects')).toHaveLength(2);
    expect(hrefSet).toEqual(['/desktop/setup?p=proj-1']);
  });

  it('an empty name disables «만들기» and says why (no red border)', async () => {
    stubFetch({});
    await act(async () => { root.render(wrap()); });
    await settle();
    await type(inputs()[1], '');
    expect(createButton().disabled).toBe(true);
    expect(container.textContent).toContain('프로젝트 이름을 적어 주세요');
  });

  it('en copy', async () => {
    stubFetch({ displayName: 'Jiwoo' });
    await act(async () => { root.render(wrap('en')); });
    await settle();
    expect(container.textContent).toContain('Create your organization');
    expect(inputs().map((i) => i.value)).toEqual(["Jiwoo's organization", 'First project']);
  });
});

describe('onboarding page picks the one screen only for a valid desktop next', () => {
  it.each([
    [{ next: '/desktop/setup' }, DesktopCreateOrg],
    [{}, OnboardingForm],
    [{ next: '/chats' }, OnboardingForm],
    [{ next: '//evil.com' }, OnboardingForm],
    [{ next: '/desktop/setup', step: 'project' }, OnboardingForm],
  ])('%j', async (params, component) => {
    const el = await OnboardingPage({ searchParams: Promise.resolve(params) }) as { type: unknown; props: { children?: { type: unknown } } };
    // story #4453 — making an organization is behind the «verify your e-mail» gate; `step=project` (an organization
    // exists) is not
    if ((params as { step?: string }).step === 'project') expect(el.type).toBe(component);
    else {
      expect(el.type).toBe(EmailVerifyGate);
      expect(el.props.children?.type).toBe(component);
    }
  });
});

// story 4427 · Qadir 2nd line on 4832 (PO 04:50Z) — the failure paths: each shows the usual onboarding message, never
// navigates, and «만들기» can be pressed again. A failure after the organization exists never makes a second one.
describe('DesktopCreateOrg — failures', () => {
  type Reply = { status: number; code?: string; limit?: number } | 'network';
  function stubFailing(fail: { org?: Reply; project?: Reply }) {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push(url);
      const ok = (data: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ data, error: null, meta: null }) } as Response);
      const reply = (r: Reply) => {
        if (r === 'network') throw new TypeError('Failed to fetch');
        return { ok: false, status: r.status, headers: new Headers(), json: async () => ({ data: null, error: { code: r.code ?? 'X', message: 'm', ...(r.limit ? { limit: r.limit } : {}) }, meta: null }) } as Response;
      };
      if (url === '/api/auth/me') return ok({ member_id: 'u1', display_name: '김지우' });
      if (url === '/api/organizations') return fail.org ? reply(fail.org) : ok({ id: 'org-1', name: 'x', slug: 'workspace-abc' });
      if (url === '/api/projects') return fail.project ? reply(fail.project) : ok({ id: 'proj-1', name: 'y' });
      if (url === '/api/current-project' || url === '/api/auth/refresh') return ok({});
      throw new Error('unexpected fetch: ' + url);
    }));
    return calls;
  }
  const alertText = () => container.querySelector('[role="alert"]')?.textContent ?? '';
  const ko = koMessages.onboarding;
  async function pressCreate() {
    await act(async () => { root.render(wrap()); });
    await settle();
    await act(async () => { createButton().click(); });
    await settle();
  }

  it.each([
    ['org 403 EMAIL_VERIFICATION_REQUIRED', { org: { status: 403, code: 'EMAIL_VERIFICATION_REQUIRED' } }, ko.emailVerifyRequiredError],
    ['org 402 PLAN_LIMIT_EXCEEDED', { org: { status: 402, code: 'PLAN_LIMIT_EXCEEDED', limit: 1 } }, ko.orgLimitExceededError.replace('{limit}', '1')],
    ['org 409 (another failure)', { org: { status: 409, code: 'CONFLICT' } }, ko.createOrgFailed],
    ['org 500', { org: { status: 500 } }, ko.createOrgFailed],
    ['network error on the organization', { org: 'network' as const }, ko.networkError],
  ])('%s → its message · no navigation · «만들기» enabled again · no project call', async (_n, fail, message) => {
    const calls = stubFailing(fail as { org?: Reply });
    await pressCreate();
    expect(alertText()).toContain(message);
    expect(hrefSet).toEqual([]);
    expect(createButton().disabled).toBe(false);
    expect(createButton().textContent).toBe('만들기');
    expect(calls.filter((u) => u === '/api/projects')).toHaveLength(0);
  });

  it.each([
    ['project 402 PLAN_LIMIT_EXCEEDED', { status: 402, code: 'PLAN_LIMIT_EXCEEDED', limit: 1 } as Reply, ko.projectLimitExceededError.replace('{limit}', '1')],
    ['network error on the project', 'network' as Reply, ko.networkError],
  ])('%s → its message; the organization stays made — pressing again never creates a second one', async (_n, projectFail, message) => {
    const calls = stubFailing({ project: projectFail });
    await pressCreate();
    expect(alertText()).toContain(message);
    expect(hrefSet).toEqual([]);
    expect(createButton().disabled).toBe(false);
    await act(async () => { createButton().click(); });
    await settle();
    expect(calls.filter((u) => u === '/api/organizations')).toHaveLength(1);
    expect(calls.filter((u) => u === '/api/projects')).toHaveLength(2);
  });
});
