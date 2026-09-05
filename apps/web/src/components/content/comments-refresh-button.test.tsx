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

  it('429 rate_limited(초 있음, 60초 미만) — 버튼이 비활성되고 버튼 밖에 "{N}초 뒤에…" 문구', async () => {
    const onRefresh = vi.fn<() => Promise<CommentsRefreshOutcome>>().mockResolvedValue({ ok: false, kind: 'rate_limited', retryAfterSeconds: 45 });
    await mount(<CommentsRefreshButton onRefresh={onRefresh} />);
    const btn = container.querySelector('[data-testid="comments-refresh-button"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    expect(btn.disabled).toBe(true);
    expect(container.querySelector('[data-testid="comments-refresh-rate-limited"]')?.textContent).toBe('45초 뒤에 다시 시도할 수 있습니다.');
  });

  // story #3517 조각②-b(유나 16회차 보강, PO 確定 2026-09-06) — 429도 로드 시점
  // 차단과 같은 공식을 공유한다: 60초 이상은 분 단위로 올림("300초 뒤"처럼 사람이
  // 암산해야 하는 숫자를 안 보인다).
  it('429 rate_limited(60초 이상) — 분 단위로 올림 표시된다', async () => {
    const onRefresh = vi.fn<() => Promise<CommentsRefreshOutcome>>().mockResolvedValue({ ok: false, kind: 'rate_limited', retryAfterSeconds: 90 });
    await mount(<CommentsRefreshButton onRefresh={onRefresh} />);
    const btn = container.querySelector('[data-testid="comments-refresh-button"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    expect(container.querySelector('[data-testid="comments-refresh-rate-limited"]')?.textContent).toBe('2분 뒤에 다시 시도할 수 있습니다.');
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

  // story #3517 조각②-b(BE #3876, 유나 16회차 보강, PO 確定 2026-09-06) — 로드
  // 시점에 이미 nextAllowedAt이 미래면 사람이 한 번도 안 눌렀어도 비활성+사유 —
  // 429 응답을 받고서야 아는 게 아니라 로드 시점에 미리 안다. 60초 이상 남으면
  // 분 단위로 올림 표시(429 문구와 같은 공식 공유, commentsRefreshRateLimitedMinutes).
  it('nextAllowedAt이 5분 뒤(미래, 60초 이상)면 클릭 없이도 비활성+"{n}분 뒤에…" 문구가 뜬다(초 아님)', async () => {
    const future = new Date(Date.now() + 5 * 60_000).toISOString();
    const onRefresh = vi.fn<() => Promise<CommentsRefreshOutcome>>();
    await mount(<CommentsRefreshButton onRefresh={onRefresh} nextAllowedAt={future} />);
    const btn = container.querySelector('[data-testid="comments-refresh-button"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(onRefresh).not.toHaveBeenCalled();
    const blocked = container.querySelector('[data-testid="comments-refresh-load-time-blocked"]');
    expect(blocked?.textContent).toBe('5분 뒤에 다시 시도할 수 있습니다.');
  });

  it('nextAllowedAt이 30초 뒤(60초 미만)면 초 단위로 뜬다(분으로 뭉개지 않는다)', async () => {
    const future = new Date(Date.now() + 30_000).toISOString();
    const onRefresh = vi.fn<() => Promise<CommentsRefreshOutcome>>();
    await mount(<CommentsRefreshButton onRefresh={onRefresh} nextAllowedAt={future} />);
    const blocked = container.querySelector('[data-testid="comments-refresh-load-time-blocked"]');
    expect(blocked?.textContent).toContain('초 뒤에 다시 시도할 수 있습니다.');
    expect(blocked?.textContent).not.toContain('분 뒤');
  });

  it('nextAllowedAt이 과거(이미 지난 창)면 버튼이 정상 활성', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const onRefresh = vi.fn<() => Promise<CommentsRefreshOutcome>>().mockResolvedValue({ ok: true });
    await mount(<CommentsRefreshButton onRefresh={onRefresh} nextAllowedAt={past} />);
    const btn = container.querySelector('[data-testid="comments-refresh-button"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(container.querySelector('[data-testid="comments-refresh-load-time-blocked"]')).toBeNull();
  });

  it('nextAllowedAt=null(지금 바로 가능)이면 로드 시점 차단 문구 자체가 없다', async () => {
    const onRefresh = vi.fn<() => Promise<CommentsRefreshOutcome>>().mockResolvedValue({ ok: true });
    await mount(<CommentsRefreshButton onRefresh={onRefresh} nextAllowedAt={null} />);
    const btn = container.querySelector('[data-testid="comments-refresh-button"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(container.querySelector('[data-testid="comments-refresh-load-time-blocked"]')).toBeNull();
  });

  // story #3517 조각②-b REQUIRED 1(유나 Design 변경요청, PO 자기정정 2026-09-06) —
  // "타이머는 안 둔다"였던 최초 판단은 «새로고침 없이 페이지에 머무는 사람»을 안
  // 셌다: 창이 지나도 disabled+문구가 그대로면 "할 수 있는데 못 한다". 만료 시각에
  // setTimeout으로 비활성+문구가 함께 사라져야 한다(카운트다운 재렌더는 없다 —
  // 만료 전/후 두 스냅샷만 확인).
  describe('로드 시점 창·429(초 있음) 만료 — 해제 경로(REQUIRED 1)', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('nextAllowedAt 만료 전엔 비활성+문구, 만료 시각에 자동으로 활성+문구 부재로 바뀐다', async () => {
      vi.useFakeTimers();
      const future = new Date(Date.now() + 30_000).toISOString();
      const onRefresh = vi.fn<() => Promise<CommentsRefreshOutcome>>();
      await mount(<CommentsRefreshButton onRefresh={onRefresh} nextAllowedAt={future} />);

      const btn = container.querySelector('[data-testid="comments-refresh-button"]') as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
      expect(container.querySelector('[data-testid="comments-refresh-load-time-blocked"]')).not.toBeNull();

      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });

      expect(btn.disabled).toBe(false);
      expect(container.querySelector('[data-testid="comments-refresh-load-time-blocked"]')).toBeNull();
      expect(onRefresh).not.toHaveBeenCalled();
    });

    it('429(초 있음) 만료 전엔 비활성+문구, 만료 시각에 자동으로 활성+문구 부재로 바뀐다', async () => {
      vi.useFakeTimers();
      const onRefresh = vi.fn<() => Promise<CommentsRefreshOutcome>>().mockResolvedValue({ ok: false, kind: 'rate_limited', retryAfterSeconds: 20 });
      await mount(<CommentsRefreshButton onRefresh={onRefresh} />);
      const btn = container.querySelector('[data-testid="comments-refresh-button"]') as HTMLButtonElement;
      await act(async () => { btn.click(); });

      expect(btn.disabled).toBe(true);
      expect(container.querySelector('[data-testid="comments-refresh-rate-limited"]')).not.toBeNull();

      await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });

      expect(btn.disabled).toBe(false);
      expect(container.querySelector('[data-testid="comments-refresh-rate-limited"]')).toBeNull();
    });

    it('언마운트 시 로드 시점 창 타이머가 clearTimeout으로 정리된다(누수 0)', async () => {
      vi.useFakeTimers();
      const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
      const future = new Date(Date.now() + 30_000).toISOString();
      await mount(<CommentsRefreshButton onRefresh={vi.fn()} nextAllowedAt={future} />);

      await act(async () => { root.unmount(); });
      container.remove();

      expect(clearSpy).toHaveBeenCalled();
      // 언마운트 뒤 타이머를 흘려보내도(누수였다면 여기서 상태 업데이트 시도) 에러 없이 조용해야 한다.
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      clearSpy.mockRestore();
    });

    it('언마운트 시 429(초 있음) 타이머가 clearTimeout으로 정리된다(누수 0)', async () => {
      vi.useFakeTimers();
      const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
      const onRefresh = vi.fn<() => Promise<CommentsRefreshOutcome>>().mockResolvedValue({ ok: false, kind: 'rate_limited', retryAfterSeconds: 20 });
      await mount(<CommentsRefreshButton onRefresh={onRefresh} />);
      const btn = container.querySelector('[data-testid="comments-refresh-button"]') as HTMLButtonElement;
      await act(async () => { btn.click(); });

      await act(async () => { root.unmount(); });
      container.remove();

      expect(clearSpy).toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
      clearSpy.mockRestore();
    });
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
