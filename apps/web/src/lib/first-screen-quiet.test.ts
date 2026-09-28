// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { whenFirstScreenQuiet } from './first-screen-quiet';

// [SID:4299] 첫 화면이 조용해진 뒤 한 번 — 문서 load 뒤 새 자원 도착이 quietMs 동안 없을 때(늦어도 maxWaitMs) · 쉬는 틈에 · 취소 가능.
let resourceCb: (() => void) | null = null;
let readyState = 'complete';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
  resourceCb = null;
  readyState = 'complete';
  vi.stubGlobal('PerformanceObserver', class {
    constructor(cb: () => void) { resourceCb = cb; }
    observe() {}
    disconnect() { resourceCb = null; }
  });
  vi.spyOn(document, 'readyState', 'get').mockImplementation(() => readyState as DocumentReadyState);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('whenFirstScreenQuiet', () => {
  it('⭐조용함이 quietMs에 닿기 전엔 안 부르고, 닿으면 한 번 부른다', () => {
    const run = vi.fn();
    whenFirstScreenQuiet(run, { quietMs: 1000 });
    vi.advanceTimersByTime(750);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(600);
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('자원이 새로 도착하면 조용함을 다시 센다', () => {
    const run = vi.fn();
    whenFirstScreenQuiet(run, { quietMs: 1000 });
    vi.advanceTimersByTime(900);
    resourceCb!();
    vi.advanceTimersByTime(900);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('문서가 아직 읽히는 중이면 기다린다 — 끝나면 조용함으로', () => {
    readyState = 'interactive';
    const run = vi.fn();
    whenFirstScreenQuiet(run, { quietMs: 1000, maxWaitMs: 10_000 });
    vi.advanceTimersByTime(3000);
    expect(run).not.toHaveBeenCalled();
    readyState = 'complete';
    vi.advanceTimersByTime(300);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('자원이 쉬지 않고 와도 maxWaitMs에는 부른다', () => {
    const run = vi.fn();
    whenFirstScreenQuiet(run, { quietMs: 1000, maxWaitMs: 4000 });
    for (let i = 0; i < 20; i += 1) { vi.advanceTimersByTime(250); resourceCb?.(); }
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('취소하면 부르지 않는다', () => {
    const run = vi.fn();
    const cancel = whenFirstScreenQuiet(run, { quietMs: 1000 });
    vi.advanceTimersByTime(500);
    cancel();
    vi.advanceTimersByTime(5000);
    expect(run).not.toHaveBeenCalled();
  });
});
