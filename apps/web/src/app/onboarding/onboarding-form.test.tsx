// @vitest-environment jsdom
//
// story #2484 — 세 자리가 error.code 분기 없이(또는 존재하지 않는 코드를 보고) raw 서버
// 영문을 노출하던 자리:
//  ① resend-verification 비-429 실패 — code 미분기.
//  ② create-project — 'UPGRADE_REQUIRED'를 보는데 backend는 그 코드를 절대 안 낸다
//     (실제로는 'PLAN_LIMIT_EXCEEDED'). 이 분기는 지금껏 한 번도 안 탄 죽은 코드였다.
//  ③ create-agent — code 미분기 + 하드코딩 영문 폴백.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { OnboardingForm } from './onboarding-form';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

function setNativeValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

describe('OnboardingForm — error.code 분기 (story #2484)', () => {
  it('resend-verification 비-429 실패(USER_NOT_FOUND) — raw 영문 대신 번역 문구', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/onboarding/events') return { ok: true, json: async () => ({}) };
      if (url === '/api/organizations') {
        return { ok: false, json: async () => ({ error: { code: 'EMAIL_VERIFICATION_REQUIRED', message: 'x' } }) };
      }
      if (url === '/api/auth/resend-verification') {
        return { ok: false, status: 400, json: async () => ({ error: { code: 'USER_NOT_FOUND', message: 'User not found' } }) };
      }
      throw new Error('unexpected fetch: ' + url);
    }));
    await act(async () => { root.render(wrap(<OnboardingForm />)); });

    const nameInput = container.querySelector('input') as HTMLInputElement;
    await act(async () => { setNativeValue(nameInput, 'My Org'); });
    const createBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.onboarding.createOrg);
    await act(async () => { createBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    const resendBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.onboarding.resendVerificationCta);
    expect(resendBtn).not.toBeUndefined();
    await act(async () => { resendBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(container.textContent).not.toContain('User not found');
    expect(container.textContent).toContain(koMessages.onboarding.resendUserNotFound);
  });

  it('create-project PLAN_LIMIT_EXCEEDED(resource=project) — UpgradeModal이 실제로 뜬다(구 코드는 죽은 분기였음)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/onboarding/events') return { ok: true, json: async () => ({}) };
      if (url === '/api/projects') {
        return {
          ok: false,
          json: async () => ({ error: { code: 'PLAN_LIMIT_EXCEEDED', resource: 'project', limit: 1, tier: 'free', upgrade_required: true, message: 'Free plan project limit (1) reached. Upgrade to Team or Pro.' } }),
        };
      }
      throw new Error('unexpected fetch: ' + url);
    }));
    await act(async () => {
      root.render(wrap(<OnboardingForm initialStep="project" initialOrgId="org-1" />));
    });

    const nameInput = container.querySelector('input') as HTMLInputElement;
    await act(async () => { setNativeValue(nameInput, 'My Project'); });
    const createBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.onboarding.createProjectAction);
    await act(async () => { createBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    // story #2484 핵심 회귀가드 — 예전엔 이 분기가 절대 안 탔다(코드명이 틀려서).
    // UpgradeModal은 Dialog(base-ui) 기반이라 body에 portal된다 — container 밖에서 찾는다.
    expect(document.body.textContent).not.toContain('Free plan project limit');
    expect(document.body.textContent).toContain('무료 플랜은 프로젝트를 1개까지 만들 수 있습니다');
  });

  it('create-agent 실패 — raw/하드코딩 영문 대신 번역 문구(#2484)', async () => {
    // initialStep="project" prop은 컴포넌트 자체 로직상 "새로고침 재개"를 뜻해 프로젝트
    // 생성 성공 時 agent 단계로 안 가고 바로 대시보드로 finishToDashboard()한다 — agent
    // 단계에 실제 projectId를 갖고 도달하려면 org→project 전 과정을 그대로 밟아야 한다.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/onboarding/events') return { ok: true, json: async () => ({}) };
      if (url === '/api/organizations') return { ok: true, json: async () => ({ data: { id: 'org-1' } }) };
      if (url === '/api/auth/refresh') return { ok: true, json: async () => ({}) };
      if (url === '/api/projects') return { ok: true, json: async () => ({ data: { id: 'proj-1' } }) };
      if (url === '/api/current-project') return { ok: true, json: async () => ({}) };
      if (url === '/api/team-members') {
        return { ok: false, json: async () => ({ error: { code: 'SOME_CODE', message: 'raw server text' } }) };
      }
      throw new Error('unexpected fetch: ' + url);
    }));
    await act(async () => { root.render(wrap(<OnboardingForm />)); });

    const orgNameInput = container.querySelector('input') as HTMLInputElement;
    await act(async () => { setNativeValue(orgNameInput, 'My Org'); });
    const createOrgBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.onboarding.createOrg);
    await act(async () => { createOrgBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    const projectNameInput = container.querySelector('input') as HTMLInputElement;
    await act(async () => { setNativeValue(projectNameInput, 'My Project'); });
    const createProjectBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.onboarding.createProjectAction);
    await act(async () => { createProjectBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    const agentNameInput = container.querySelector('input') as HTMLInputElement;
    await act(async () => { setNativeValue(agentNameInput, 'My Agent'); });
    const createAgentBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.onboarding.createAgentAction);
    await act(async () => { createAgentBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(container.textContent).not.toContain('raw server text');
    expect(container.textContent).not.toContain('Failed to create agent');
    expect(container.textContent).toContain(koMessages.onboarding.createAgentFailed);
  });
});
