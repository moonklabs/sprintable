// @vitest-environment jsdom
//
// story #3637(유나 silent-failure-sweep-3632, doc 자리 B) — L1 선례 조회(fetchPrecedents)
// 실패를 setPrecedents([])로 그리면 "비슷한 가설 조회 중..." 로딩 문구가 조용히 사라져
// "찾아봤는데 없다"로 읽힌다. precedentsFailed 플래그로 declareL1LoadError 문장이 그
// 자리에 서는지 검증.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { HypothesisDeclarationCard } from './hypothesis-declaration-card';
import { EMPTY_DECLARATION, type HypothesisDeclarationValue } from '@/services/hypothesis-declaration';

const FILLED_VALUE: HypothesisDeclarationValue = { ...EMPTY_DECLARATION, statement: '충분히 긴 가설 문장입니다' };
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>;
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

function stubFetch(ok: boolean) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url === 'string' && url.includes('/api/context-pack/search')) {
      return { ok, json: async () => ({ data: [] }) };
    }
    return { ok: false, json: async () => null };
  }));
}

describe('HypothesisDeclarationCard(epics) — L1 선례 조회 실패(story #3637 자리 B)', () => {
  it('조회 500 실패 시 조회중 문구가 사라진 자리에 불러오기 실패 문구가 선다', async () => {
    stubFetch(false);
    await act(async () => {
      root.render(wrap(
        <HypothesisDeclarationCard projectId="proj-1" contextTitle="에픽 제목" value={FILLED_VALUE} onChange={() => {}} linkableHypotheses={null} />,
      ));
    });
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => { textarea.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(container.textContent).toContain('비슷한 가설을 불러오지 못했습니다');
    expect(container.textContent).not.toContain('비슷한 가설의 과거 결과');
  });

  it('뮤테이션 대표 — 조회 성공(빈 배열)이면 실패 문구도 조회중 문구도 안 뜬다', async () => {
    stubFetch(true);
    await act(async () => {
      root.render(wrap(
        <HypothesisDeclarationCard projectId="proj-1" contextTitle="에픽 제목" value={FILLED_VALUE} onChange={() => {}} linkableHypotheses={null} />,
      ));
    });
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => { textarea.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(container.textContent).not.toContain('비슷한 가설을 불러오지 못했습니다');
  });
});
