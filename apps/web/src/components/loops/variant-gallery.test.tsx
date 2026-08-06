// @vitest-environment jsdom
//
// story #2485 — code로 분기(backend loops.py decide_loop()이 dict{code,message}로 직접
// 발급 — route.ts는 순수 passthrough, mapApiError 경유 아님이라 전부 정확히 도달한다).
// 6종 전부 + 알려지지 않은 code 안전폴백을 검증한다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { VariantGallery, type VariantGroup } from './variant-gallery';
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

const GROUPS: VariantGroup[] = [
  {
    variant_group: 'headline',
    artifacts: [
      { id: 'a1', loop_id: 'loop-1', asset_id: 's1', variant_group: 'headline', variant_label: 'A', decision: 'pending', choose_reason: null, rejection_reason: null, sort_order: 0 },
      { id: 'a2', loop_id: 'loop-1', asset_id: 's2', variant_group: 'headline', variant_label: 'B', decision: 'pending', choose_reason: null, rejection_reason: null, sort_order: 1 },
    ],
  },
];

async function mountAndSubmit(errorCode: string) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: false,
    json: async () => ({ error: { code: errorCode, message: `raw ${errorCode} message` } }),
  })));
  await act(async () => { root.render(wrap(<VariantGallery loopId="loop-1" groups={GROUPS} canDecide onDecided={() => {}} />)); });
  await flush();

  const radios = container.querySelectorAll('input[type="radio"]');
  await act(async () => { (radios[0] as HTMLInputElement).click(); });
  const textareas = container.querySelectorAll('textarea');
  for (const ta of Array.from(textareas) as HTMLTextAreaElement[]) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(ta, '이유 텍스트'); ta.dispatchEvent(new Event('input', { bubbles: true })); });
  }
  const submitBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === koMessages.loops.confirmSlot);
  await act(async () => { submitBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await flush();
}

describe('VariantGallery — error.code 분기 (story #2485)', () => {
  it('LOOP_NOT_FOUND', async () => {
    await mountAndSubmit('LOOP_NOT_FOUND');
    expect(container.textContent).not.toContain('raw LOOP_NOT_FOUND message');
    expect(container.textContent).toContain(koMessages.loops.decisionErrorLoopNotFound);
  });

  it('DECISION_HUMAN_ONLY', async () => {
    await mountAndSubmit('DECISION_HUMAN_ONLY');
    expect(container.textContent).not.toContain('raw DECISION_HUMAN_ONLY message');
    expect(container.textContent).toContain(koMessages.loops.decisionErrorHumanOnly);
  });

  it('LOOP_NOT_IN_DECIDING_STATE', async () => {
    await mountAndSubmit('LOOP_NOT_IN_DECIDING_STATE');
    expect(container.textContent).not.toContain('raw LOOP_NOT_IN_DECIDING_STATE message');
    expect(container.textContent).toContain(koMessages.loops.decisionErrorNotDeciding);
  });

  it('GATE_ALREADY_RESOLVED', async () => {
    await mountAndSubmit('GATE_ALREADY_RESOLVED');
    expect(container.textContent).not.toContain('raw GATE_ALREADY_RESOLVED message');
    expect(container.textContent).toContain(koMessages.loops.decisionErrorGateResolved);
  });

  it('NO_PENDING_ARTIFACTS_IN_GROUP', async () => {
    await mountAndSubmit('NO_PENDING_ARTIFACTS_IN_GROUP');
    expect(container.textContent).not.toContain('raw NO_PENDING_ARTIFACTS_IN_GROUP message');
    expect(container.textContent).toContain(koMessages.loops.decisionErrorNoPendingArtifacts);
  });

  it('ARTIFACT_SET_MISMATCH', async () => {
    await mountAndSubmit('ARTIFACT_SET_MISMATCH');
    expect(container.textContent).not.toContain('raw ARTIFACT_SET_MISMATCH message');
    expect(container.textContent).toContain(koMessages.loops.decisionErrorArtifactSetMismatch);
  });

  it('알려지지 않은 code — 안전 폴백, raw message 미노출', async () => {
    await mountAndSubmit('SOME_NEW_CODE');
    expect(container.textContent).not.toContain('raw SOME_NEW_CODE message');
    expect(container.textContent).toContain(koMessages.loops.decisionError);
  });
});
