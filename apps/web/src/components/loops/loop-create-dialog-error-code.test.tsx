// @vitest-environment jsdom
//
// story #2485 — LOOP_HYPOTHESIS_REQUIRED 외 4종 추가 code 분기(backend loops.py
// create_loop()가 dict{code,message}로 직접 발급 — router _raise()가 그대로 통과,
// mapApiError 경유 아님). loop-create-dialog.test.tsx(순수함수 localizeRecipe 테스트)와는
// 별개 파일 — 여기는 풀 마운트 폼 검증.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { LoopCreateDialog } from './loop-create-dialog';
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

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

async function mountFilledDialog(errorCode: string) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/workflow-recipes') return { ok: false, json: async () => ({}) };
    if (url === '/api/loops' && init?.method === 'POST') {
      return { ok: false, json: async () => ({ error: { code: errorCode, message: `raw ${errorCode} message` } }) };
    }
    throw new Error('unexpected fetch: ' + url);
  }));
  await act(async () => {
    root.render(wrap(<LoopCreateDialog projectId="proj-1" open onOpenChange={() => {}} onCreated={() => {}} />));
  });
  await flush();

  // document.body 전체에서 폼 요소를 찾는다 — base-ui Dialog는 body에 portal된다.
  const titleInput = document.body.querySelector('input') as HTMLInputElement;
  await act(async () => { setNativeValue(titleInput, '테스트 루프'); });
  const statementTextarea = document.body.querySelector('textarea') as HTMLTextAreaElement;
  await act(async () => { setNativeValue(statementTextarea, '가설 문장'); });
  const inputs = Array.from(document.body.querySelectorAll('input'));
  const metricInput = inputs[1] as HTMLInputElement; // title 다음 첫 텍스트 input = metric
  await act(async () => { setNativeValue(metricInput, 'conversion_rate'); });
  const dateInput = document.body.querySelector('input[type="date"]') as HTMLInputElement;
  await act(async () => { setNativeValue(dateInput, '2026-09-01'); });

  const submitBtn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === koMessages.loops.createLoopSubmit);
  await act(async () => { submitBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await flush();
}

describe('LoopCreateDialog — error.code 분기 확장 (story #2485)', () => {
  it('HUMAN_OWNER_REQUIRED', async () => {
    await mountFilledDialog('HUMAN_OWNER_REQUIRED');
    expect(document.body.textContent).not.toContain('raw HUMAN_OWNER_REQUIRED message');
    expect(document.body.textContent).toContain(koMessages.loops.createLoopErrorHumanOwnerRequired);
  });

  it('INVALID_CREATE_STATUS', async () => {
    await mountFilledDialog('INVALID_CREATE_STATUS');
    expect(document.body.textContent).not.toContain('raw INVALID_CREATE_STATUS message');
    expect(document.body.textContent).toContain(koMessages.loops.createLoopErrorInvalidStatus);
  });

  it('HYPOTHESIS_NOT_FOUND', async () => {
    await mountFilledDialog('HYPOTHESIS_NOT_FOUND');
    expect(document.body.textContent).not.toContain('raw HYPOTHESIS_NOT_FOUND message');
    expect(document.body.textContent).toContain(koMessages.loops.createLoopErrorHypothesisNotFound);
  });

  it('HYPOTHESIS_PROJECT_MISMATCH', async () => {
    await mountFilledDialog('HYPOTHESIS_PROJECT_MISMATCH');
    expect(document.body.textContent).not.toContain('raw HYPOTHESIS_PROJECT_MISMATCH message');
    expect(document.body.textContent).toContain(koMessages.loops.createLoopErrorHypothesisProjectMismatch);
  });

  it('알려지지 않은 code — 안전 폴백, raw message 미노출', async () => {
    await mountFilledDialog('SOME_NEW_CODE');
    expect(document.body.textContent).not.toContain('raw SOME_NEW_CODE message');
    expect(document.body.textContent).toContain(koMessages.loops.createLoopErrorGeneric);
  });
});
