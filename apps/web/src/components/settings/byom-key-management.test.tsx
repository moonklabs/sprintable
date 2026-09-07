// @vitest-environment jsdom
//
// story #3644(3632 후속, 유나 v3.1 목록 즉시 결함) — /api/projects/{id}/ai-settings/validate
// 가 valid/invalid/unknown 세 값을 낸다. 이 컴포넌트가 status==='unknown'을 'error'로
// 뭉개지 않고 별도 문구(validationUnknown)로 렌더하는지 검증한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ByomKeyManagement } from './byom-key-management';

const { fetchWithAuthMock } = vi.hoisted(() => ({ fetchWithAuthMock: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: fetchWithAuthMock }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fetchWithAuthMock.mockReset();
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

function setNativeValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

async function mount() {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <ByomKeyManagement projectId="proj-1" />
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('ByomKeyManagement — 검증 결과 3값(story #3644)', () => {
  it('BE가 status="unknown"을 내면 "확인 실패"가 아니라 별도 문구를 보인다', async () => {
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      if (url.includes('/ai-settings/validate')) {
        return { ok: true, json: async () => ({ data: { status: 'unknown', project_id: 'proj-1' } }) };
      }
      return { ok: true, json: async () => ({ data: null }) };
    });
    await mount();

    const input = container.querySelector('input[type="password"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    await act(async () => { setNativeValue(input, 'sk-test-key'); });

    const validateBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '검증');
    expect(validateBtn).toBeDefined();
    await act(async () => { validateBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    expect(container.textContent).toContain(koMessages.settings.byomKeys.validationUnknown);
    expect(container.textContent).not.toContain(koMessages.settings.byomKeys.validationError);
  });

  it('BE가 status="invalid"를 내면 기존 실패 문구가 그대로 뜬다(회귀 없음)', async () => {
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      if (url.includes('/ai-settings/validate')) {
        return { ok: true, json: async () => ({ data: { status: 'invalid', project_id: 'proj-1' } }) };
      }
      return { ok: true, json: async () => ({ data: null }) };
    });
    await mount();

    const input = container.querySelector('input[type="password"]') as HTMLInputElement;
    await act(async () => { setNativeValue(input, 'sk-bad-key'); });
    const validateBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '검증');
    await act(async () => { validateBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    expect(container.textContent).toContain(koMessages.settings.byomKeys.validationError);
  });
});
