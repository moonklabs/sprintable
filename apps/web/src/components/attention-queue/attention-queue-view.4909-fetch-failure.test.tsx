// @vitest-environment jsdom
//
// 4909 (가) — «지금 개입할 것» 읽기 실패가 «안전 · 지금 개입할 것 없음»으로 보이던 결함.
// 실패(네트워크 예외 · 비정상 응답)는 빈 목록이 아니다: 처음 읽기가 실패하면 «못 불러왔어요 + 다시 시도»,
// 이미 목록이 있는 상태에서 새로 읽기가 실패하면 목록을 비우지 않고 «최신 상태를 못 불러왔어요» 한 줄.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

const { sseHandlers } = vi.hoisted(() => ({
  sseHandlers: { onExtraEvent: null as null | ((name: string, data: unknown) => void) },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@/hooks/use-sse-notifications', () => ({
  useSseNotifications: (opts: { onExtraEvent?: (name: string, data: unknown) => void }) => {
    sseHandlers.onExtraEvent = opts.onExtraEvent ?? null;
  },
}));

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
  vi.resetModules();
  sseHandlers.onExtraEvent = null;
});

type FetchResult = { ok: boolean; json: () => Promise<unknown> };
const goodBody = {
  data: { items: [{ kind: 'gate_pending', story_id: 's1', title: '가격 콘솔', ref: {}, entered_state_at: null }] },
};
const emptyBody = { data: { items: [] } };

async function flush() {
  await act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); });
}

async function mount(fetchImpl: () => Promise<FetchResult>, locale: 'ko' | 'en' = 'ko') {
  vi.stubGlobal('fetch', vi.fn(fetchImpl));
  const { AttentionQueueView } = await import('./attention-queue-view');
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul">
        <AttentionQueueView projectId="proj-1" />
      </NextIntlClientProvider>,
    );
  });
  await flush();
}

const text = () => container.textContent ?? '';
const retry = () => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === '다시 시도');

describe('AttentionQueueView — 4909 (가) 읽기 실패는 «안전»이 아니다', () => {
  it('⭐네트워크 예외면 «안전 · 지금 개입할 것 없음» 대신 «못 불러왔어요 + 다시 시도»', async () => {
    await mount(async () => { throw new Error('network down'); });
    expect(container.querySelector('[data-testid="attention-load-failed"]')).toBeTruthy();
    expect(text()).toContain('지금 개입할 것을 불러오지 못했어요');
    expect(text()).not.toContain('안전');
    expect(text()).not.toContain('지금 개입할 것 없음');
    expect(retry()).toBeTruthy();
  });

  it('⭐비정상 응답(500)도 같은 얼굴 — «0건» 머리 문구도 안 보인다', async () => {
    await mount(async () => ({ ok: false, json: async () => ({}) }));
    expect(container.querySelector('[data-testid="attention-load-failed"]')).toBeTruthy();
    expect(text()).not.toContain('안전');
    expect(text()).not.toContain('0건');
  });

  it('JSON이 깨진 200 응답도 실패로 센다', async () => {
    await mount(async () => ({ ok: true, json: async () => { throw new SyntaxError('bad json'); } }));
    expect(container.querySelector('[data-testid="attention-load-failed"]')).toBeTruthy();
    expect(text()).not.toContain('안전');
  });

  it('진짜로 비었을 때(200 · 빈 목록)는 지금처럼 «안전»이다 — 실패 얼굴이 새지 않는다', async () => {
    await mount(async () => ({ ok: true, json: async () => emptyBody }));
    expect(container.querySelector('[data-testid="attention-load-failed"]')).toBeNull();
    expect(text()).toContain('안전');
    expect(text()).toContain('지금 개입할 것 없음');
  });

  it('«다시 시도»가 성공하면 실패 얼굴이 사라지고 목록이 선다', async () => {
    let ok = false;
    await mount(async () => (ok ? { ok: true, json: async () => goodBody } : { ok: false, json: async () => ({}) }));
    expect(container.querySelector('[data-testid="attention-load-failed"]')).toBeTruthy();
    ok = true;
    await act(async () => { retry()!.click(); });
    await flush();
    expect(container.querySelector('[data-testid="attention-load-failed"]')).toBeNull();
    expect(text()).toContain('가격 콘솔');
  });

  it('«다시 시도»가 또 실패하면 실패 얼굴이 그대로다(«안전»으로 바뀌지 않는다)', async () => {
    await mount(async () => { throw new Error('still down'); });
    await act(async () => { retry()!.click(); });
    await flush();
    expect(container.querySelector('[data-testid="attention-load-failed"]')).toBeTruthy();
    expect(text()).not.toContain('안전');
  });

  it('⭐목록이 있는 상태에서 새로 읽기(SSE)가 실패해도 목록을 비우지 않고 «최신 상태를 못 불러왔어요» 한 줄만 더한다', async () => {
    let fail = false;
    await mount(async () => {
      if (fail) throw new Error('blip');
      return { ok: true, json: async () => goodBody };
    });
    expect(text()).toContain('가격 콘솔');
    expect(container.querySelector('[data-testid="attention-load-stale"]')).toBeNull();
    fail = true;
    await act(async () => {
      sseHandlers.onExtraEvent?.('story.trust_stage_changed', { project_id: 'proj-1' });
      await new Promise((r) => setTimeout(r, 650));
    });
    await flush();
    expect(text()).toContain('가격 콘솔');
    expect(text()).not.toContain('안전');
    expect(container.querySelector('[data-testid="attention-load-stale"]')).toBeTruthy();
    expect(text()).toContain('최신 상태를 불러오지 못했어요');
  });

  it('⭐겹친 읽기: 오래된 처음 읽기(빈 목록)가 더 새로운 실패 뒤에 도착해도 실패 표시를 지우지 않는다(«안전»으로 안 바뀜)', async () => {
    let call = 0;
    let releaseFirst: (v: FetchResult) => void = () => {};
    await mount(() => {
      call += 1;
      if (call === 1) return new Promise<FetchResult>((resolve) => { releaseFirst = resolve; }); // 처음 읽기: 늦게 도착
      return Promise.reject(new Error('refetch failed'));
    });
    await act(async () => {
      sseHandlers.onExtraEvent?.('story.trust_stage_changed', { project_id: 'proj-1' });
      await new Promise((r) => setTimeout(r, 650));
    });
    await flush();
    expect(container.querySelector('[data-testid="attention-load-failed"]')).toBeTruthy();
    await act(async () => { releaseFirst({ ok: true, json: async () => emptyBody }); });
    await flush();
    expect(container.querySelector('[data-testid="attention-load-failed"]')).toBeTruthy();
    expect(text()).not.toContain('안전');
  });

  it('⭐겹친 재조회: 오래된 재조회(빈 목록)가 더 새로운 실패 뒤에 도착해도 «최신 상태를 못 불러왔어요»가 남고 목록도 그대로다', async () => {
    let call = 0;
    let releaseSecond: (v: FetchResult) => void = () => {};
    await mount(() => {
      call += 1;
      if (call === 1) return Promise.resolve({ ok: true, json: async () => goodBody });
      if (call === 2) return new Promise<FetchResult>((resolve) => { releaseSecond = resolve; }); // 첫 재조회: 늦게 도착
      return Promise.reject(new Error('second refetch failed'));
    });
    expect(text()).toContain('가격 콘솔');
    for (let i = 0; i < 2; i += 1) {
      await act(async () => {
        sseHandlers.onExtraEvent?.('story.trust_stage_changed', { project_id: 'proj-1' });
        await new Promise((r) => setTimeout(r, 650));
      });
      await flush();
    }
    expect(container.querySelector('[data-testid="attention-load-stale"]')).toBeTruthy();
    await act(async () => { releaseSecond({ ok: true, json: async () => emptyBody }); });
    await flush();
    expect(container.querySelector('[data-testid="attention-load-stale"]')).toBeTruthy();
    expect(text()).toContain('가격 콘솔');
    expect(text()).not.toContain('안전');
  });

  it('en에서도 같은 얼굴(문구 키가 둘 다 있다)', async () => {
    await mount(async () => { throw new Error('down'); }, 'en');
    expect(text()).toContain("Couldn't load what needs your call");
    expect(text()).not.toContain('ALL CLEAR');
  });
});
