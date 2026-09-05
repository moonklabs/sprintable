// @vitest-environment jsdom
//
// story #3517(BE #3865 조각①, 유나 §22-10③) — 수동 재수집 버튼. 429(비활성+버튼
// 밖 Retry-After 문구)·422(버튼 자체가 사라지고 "네 번째 얼굴")·그 외(403·502 등,
// 서버 message 그대로)를 구분한다.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { CommentsRefreshButton, type CommentsRefreshOutcome } from './comments-refresh-button';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>;
}

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

function mount(node: React.ReactNode) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  return act(async () => { root.render(wrap(node)); });
}

describe('CommentsRefreshButton', () => {
  it('클릭 — onRefresh 호출, 성공하면 에러 문구가 없다', async () => {
    const onRefresh = vi.fn<() => Promise<CommentsRefreshOutcome>>().mockResolvedValue({ ok: true });
    await mount(<CommentsRefreshButton onRefresh={onRefresh} />);
    const btn = container.querySelector('[data-testid="comments-refresh-button"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-testid="comments-refresh-error"]')).toBeNull();
  });

  it('429 rate_limited(초 있음) — 버튼이 비활성되고 버튼 밖에 "{N}초 뒤에…" 문구', async () => {
    const onRefresh = vi.fn<() => Promise<CommentsRefreshOutcome>>().mockResolvedValue({ ok: false, kind: 'rate_limited', retryAfterSeconds: 60 });
    await mount(<CommentsRefreshButton onRefresh={onRefresh} />);
    const btn = container.querySelector('[data-testid="comments-refresh-button"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    expect(btn.disabled).toBe(true);
    expect(container.querySelector('[data-testid="comments-refresh-rate-limited"]')?.textContent).toBe('60초 뒤에 다시 시도할 수 있습니다.');
  });

  it('429 rate_limited(초 모름, Retry-After 헤더 없음) — "잠시 뒤"(초를 지어내지 않는다)', async () => {
    const onRefresh = vi.fn<() => Promise<CommentsRefreshOutcome>>().mockResolvedValue({ ok: false, kind: 'rate_limited', retryAfterSeconds: null });
    await mount(<CommentsRefreshButton onRefresh={onRefresh} />);
    const btn = container.querySelector('[data-testid="comments-refresh-button"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    expect(btn.disabled).toBe(true);
    expect(container.querySelector('[data-testid="comments-refresh-rate-limited"]')?.textContent).toBe('잠시 뒤에 다시 시도할 수 있습니다.');
  });

  it('422 unsupported — 버튼 자체가 사라지고 지원 안 함 문구만 남는다(네 번째 얼굴)', async () => {
    const onRefresh = vi.fn<() => Promise<CommentsRefreshOutcome>>().mockResolvedValue({ ok: false, kind: 'unsupported' });
    await mount(<CommentsRefreshButton onRefresh={onRefresh} />);
    const btn = container.querySelector('[data-testid="comments-refresh-button"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    expect(container.querySelector('[data-testid="comments-refresh-button"]')).toBeNull();
    expect(container.querySelector('[data-testid="comments-refresh-unsupported"]')?.textContent).toBe('이 채널은 댓글을 지원하지 않습니다.');
  });

  it('403 COMMENT_REFRESH_HUMAN_ONLY(generic) — 서버 문구를 그대로 보인다', async () => {
    const onRefresh = vi.fn<() => Promise<CommentsRefreshOutcome>>().mockResolvedValue({ ok: false, kind: 'generic', message: '사람만 다시 수집할 수 있습니다' });
    await mount(<CommentsRefreshButton onRefresh={onRefresh} />);
    const btn = container.querySelector('[data-testid="comments-refresh-button"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    expect(container.querySelector('[data-testid="comments-refresh-error"]')?.textContent).toBe('사람만 다시 수집할 수 있습니다');
  });

  it('제출 중엔 버튼이 비활성+"수집 중..." 라벨', async () => {
    let resolvePromise: (v: CommentsRefreshOutcome) => void = () => {};
    const onRefresh = vi.fn<() => Promise<CommentsRefreshOutcome>>().mockReturnValue(new Promise((resolve) => { resolvePromise = resolve; }));
    await mount(<CommentsRefreshButton onRefresh={onRefresh} />);
    const btn = container.querySelector('[data-testid="comments-refresh-button"]') as HTMLButtonElement;
    act(() => { btn.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toBe('수집 중...');
    await act(async () => { resolvePromise({ ok: true }); await Promise.resolve(); });
  });
});
