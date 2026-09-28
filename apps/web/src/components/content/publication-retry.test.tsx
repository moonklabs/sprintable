// @vitest-environment jsdom
// story #4266 — 발행 재시도 공용 결과 처리: 분류(성공 · 404 재시도 대상 아님 · 알려진 코드 · 모르는 실패 · 네트워크)와 결과 줄 문장(ko · en).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

const { fetchWithAuthMock } = vi.hoisted(() => ({ fetchWithAuthMock: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: fetchWithAuthMock }));

import { postPublicationRetry, PublicationRetryResultLine, type PublicationRetryResult } from './publication-retry';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); fetchWithAuthMock.mockReset(); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe('postPublicationRetry — 분류', () => {
  it('200 → success · 404 → not_retryable(서버 문장 버림)', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(res(200, { id: 'c', status: 'pending' }));
    expect(await postPublicationRetry('/x')).toEqual({ type: 'success' });
    fetchWithAuthMock.mockResolvedValueOnce(res(404, { detail: 'command를 찾을 수 없거나 재시도 대상이 아닙니다' }));
    expect(await postPublicationRetry('/x')).toEqual({ type: 'not_retryable' });
  });

  it('알려진 코드 → 그 로케일 키 · 모르는 실패 → «다시 시도하지 못했어요.» 키(서버 message 안 씀) · 네트워크 → 같은 키', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(res(403, { detail: { code: 'CHANNEL_POST_PUBLISH_HUMAN_ONLY', message: '원문' } }));
    expect(await postPublicationRetry('/x')).toMatchObject({ type: 'error', messageKey: 'errorChannelPublishHumanOnly' });
    fetchWithAuthMock.mockResolvedValueOnce(res(500, { detail: '내부 서버 원문' }));
    expect(await postPublicationRetry('/x')).toEqual({ type: 'error', messageKey: undefined, raw: expect.anything() }); // 모르는 실패 = 키 없음(서버 message 안 씀)
    fetchWithAuthMock.mockRejectedValueOnce(new TypeError('network'));
    expect(await postPublicationRetry('/x')).toEqual({ type: 'error' });
  });
});

describe('PublicationRetryResultLine — 404 문장(유나 확정)', () => {
  async function render(result: PublicationRetryResult, locale: 'ko' | 'en') {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul">
          <PublicationRetryResultLine result={result} testId="r" />
        </NextIntlClientProvider>,
      );
    });
    return container.querySelector('[data-testid="r"]');
  }

  it('ko · en 모두 확정 문장 · en 화면에 한국어 0', async () => {
    expect((await render({ type: 'not_retryable' }, 'ko'))?.textContent).toBe('지금은 다시 시도할 수 없는 상태예요. 최신 상태를 다시 불러왔어요.');
    const en = await render({ type: 'not_retryable' }, 'en');
    expect(en?.textContent).toBe("This can't be retried right now. We reloaded the latest status.");
    expect(en?.textContent).not.toMatch(/[가-힣]/);
    expect(en?.getAttribute('role')).toBe('status'); // 오류가 아니라 안내(다시 읽은 상태가 정답)
  });
});
