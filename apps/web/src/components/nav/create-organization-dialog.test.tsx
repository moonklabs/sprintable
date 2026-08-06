// @vitest-environment jsdom
//
// story #2470 — 실측(2026-08-06): 이 다이얼로그의 PLAN_LIMIT_EXCEEDED 감지가
// `json.detail?.code`를 봤는데, 실제 응답 envelope은 `{error:{code,...}}`다(BE
// HTTPException(detail=...)이 exception handler를 거쳐 `error`로 재포장된다 — 직접
// `/api/organizations` 라이브 호출로 확認). `json.detail`은 실제 응답에 없는 필드라 이
// 분기가 항상 죽어있었고, 한도 초과여도 매번 raw `error.message`(영문) 폴백으로 샜다.
// 소스매칭(코드가 "있는지")만으론 이 결함이 안 잡힌다 — 실제로 마운트해 배너가 뜨는지 본다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CreateOrganizationDialog } from './create-organization-dialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

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

async function mount() {
  const onOpenChange = vi.fn();
  const onCreated = vi.fn();
  // Dialog(base-ui)는 body에 portal되므로 container 밖(document.body)에서 내용을 찾는다
  // (create-organization-dialog는 <Dialog open> 자체가 portal 루트라 여기서도 동일 함정).
  await act(async () => {
    root.render(<CreateOrganizationDialog open onOpenChange={onOpenChange} onCreated={onCreated} />);
  });
  return { onOpenChange, onCreated };
}

async function fillAndSubmit() {
  const nameInput = document.body.querySelector('#org-name') as HTMLInputElement;
  await act(async () => { setNativeValue(nameInput, 'Test Org'); });
  const form = document.body.querySelector('form') as HTMLFormElement;
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

describe('CreateOrganizationDialog — PLAN_LIMIT_EXCEEDED envelope (story #2470)', () => {
  it('실제 응답 envelope({error:{code}})으로 한도 배너가 실제로 뜬다 — raw 영문 message 노출 없음', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 402,
      json: async () => ({
        data: null,
        error: {
          code: 'PLAN_LIMIT_EXCEEDED',
          message: 'Free plan org limit (1) reached. Upgrade to Team or Pro.',
          resource: 'org', limit: 1, tier: 'free', upgrade_required: true,
        },
        meta: null,
      }),
    })));

    await mount();
    await fillAndSubmit();

    expect(document.body.textContent).not.toContain('Free plan org limit (1) reached');
    expect(document.body.textContent).toContain('Free 플랜 Organization 한도 초과');
    expect(document.body.querySelector('a[href="/settings?tab=billing"]')).not.toBeNull();
  });

  it('구 shape({detail:{code}})로 응답이 와도(과거 BE) 여전히 배너가 뜬다 — 하위호환 폴백', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 402,
      json: async () => ({ detail: { code: 'PLAN_LIMIT_EXCEEDED', message: 'x' } }),
    })));

    await mount();
    await fillAndSubmit();

    expect(document.body.textContent).toContain('Free 플랜 Organization 한도 초과');
  });

  it('다른 에러는 기존 일반 배너로 간다(회귀 없음)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 409,
      json: async () => ({ data: null, error: { code: 'CONFLICT', message: 'Slug already exists' }, meta: null }),
    })));

    await mount();
    await fillAndSubmit();

    expect(document.body.textContent).toContain('Slug already exists');
    expect(document.body.textContent).not.toContain('Free 플랜 Organization 한도 초과');
  });
});
