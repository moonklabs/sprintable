// @vitest-environment jsdom
//
// story #3637(유나 silent-failure-sweep-3632, doc silent-failure-sweep-3632 자리 A) —
// 가설 목록 조회 실패를 setHypotheses([])로 그리면 "연결 가능한 가설이 없습니다"가
// 실제로 뜬다(모름을 없음으로 오독). hypothesesFailed 플래그로 갈라 flow.earthLoadError
// 문장이 서는지 직접 검증.

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

function clickLinkTab() {
  // base-ui Dialog는 document.body에 portal된다(loop-create-dialog-error-code.test.tsx 관례).
  const btn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === koMessages.loops.createLoopModeLink);
  if (!btn) throw new Error('link 탭 버튼을 못 찾음');
  act(() => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

describe('LoopCreateDialog — 가설 링크 목록 조회 실패(story #3637 자리 A)', () => {
  it('가설 조회 500 실패 시 "없음" 문구가 아니라 불러오기 실패 문구가 선다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/hypotheses')) return { ok: false, json: async () => ({}) };
      if (url === '/api/events/definitions') return { ok: false, json: async () => ({}) };
      throw new Error('unexpected fetch: ' + url);
    }));
    await act(async () => {
      root.render(wrap(<LoopCreateDialog projectId="proj-1" open onOpenChange={() => {}} onCreated={() => {}} />));
    });
    await flush();
    clickLinkTab();
    await flush();

    expect(document.body.textContent).toContain(koMessages.flow.earthLoadError);
    expect(document.body.textContent).not.toContain(koMessages.loops.createLoopLinkEmpty);
  });

  it('가설 조회 성공 시(빈 배열) "없음" 문구가 그대로 선다(회귀 — 진짜 빈 목록은 그대로)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/hypotheses')) return { ok: true, json: async () => ({ data: [] }) };
      if (url === '/api/events/definitions') return { ok: false, json: async () => ({}) };
      throw new Error('unexpected fetch: ' + url);
    }));
    await act(async () => {
      root.render(wrap(<LoopCreateDialog projectId="proj-1" open onOpenChange={() => {}} onCreated={() => {}} />));
    });
    await flush();
    clickLinkTab();
    await flush();

    expect(document.body.textContent).toContain(koMessages.loops.createLoopLinkEmpty);
    expect(document.body.textContent).not.toContain(koMessages.flow.earthLoadError);
  });

  // 뮤테이션 대표(AC3) — hypothesesFailed 분기를 제거하면(구 setHypotheses([]) 흉내) 첫 번째
  // 테스트가 RED로 돌아가는지는 소스 코드 리뷰로 확認(실패 시 "없음" 문구가 다시 뜬다) —
  // 여기서는 반대편(성공=빈 배열) 케이스와의 대조로 두 문구가 서로 배타적임을 고정한다.
});
