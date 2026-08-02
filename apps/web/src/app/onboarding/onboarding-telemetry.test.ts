// @vitest-environment jsdom
//
// story(2026-08-02, 채용 흐름 텔레메트리 부재) — connect-step.tsx는 config_copied·
// verify_started·abandoned_explicit 셋을 쏘는데 recruiter STEP5엔 onboarding-telemetry
// import 자체가 없었다. 이 회귀를 다시 못 만들도록, 실제로 fetch에 실리는 body(meta.flow
// 포함)를 직접 검증한다 — emit이 fire-and-forget(fetch 실패 swallow)이라 "호출됐다"만으론
// 부족하고 "무엇을 보냈는가"까지 재야 한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emitOnboardingEvent, beaconOnboardingEvent } from './onboarding-telemetry';

function lastFetchBody(mockFetch: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = mockFetch.mock.calls.at(-1);
  return JSON.parse(call![1].body as string);
}

describe('emitOnboardingEvent — meta.flow 조립(story #2413 계열 — 채용 흐름 텔레메트리)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('flow를 주면 meta.flow로 담긴다(recruit)', () => {
    emitOnboardingEvent('config_copied', { agent_id: 'a1', flow: 'recruit' });
    const body = lastFetchBody(fetchMock);
    expect(body.event).toBe('config_copied');
    expect(body.meta).toEqual({ flow: 'recruit' });
  });

  it('flow를 주면 meta.flow로 담긴다(onboarding)', () => {
    emitOnboardingEvent('verify_started', { agent_id: 'a1', flow: 'onboarding' });
    const body = lastFetchBody(fetchMock);
    expect(body.meta).toEqual({ flow: 'onboarding' });
  });

  it('음성대조 — flow를 안 주면 meta가 빈 객체다(기존 호출부 무회귀)', () => {
    emitOnboardingEvent('abandoned_explicit', { agent_id: 'a1', failure_reason: 'abandoned_explicit' });
    const body = lastFetchBody(fetchMock);
    expect(body.meta).toEqual({});
  });

  it('POST 대상은 항상 /api/onboarding/events다', () => {
    emitOnboardingEvent('config_copied', { flow: 'recruit' });
    const url = fetchMock.mock.calls.at(-1)![0];
    expect(url).toBe('/api/onboarding/events');
  });
});

describe('beaconOnboardingEvent — sendBeacon 경로도 meta.flow를 싣는다', () => {
  it('sendBeacon 지원 시 그 Blob 본문에 meta.flow가 실린다', async () => {
    const sendBeacon = vi.fn((_url: string, _data: Blob) => true);
    vi.stubGlobal('navigator', { ...navigator, sendBeacon });
    beaconOnboardingEvent('abandoned_explicit', { agent_id: 'a1', failure_reason: 'abandoned_explicit', flow: 'recruit' });
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const blob = sendBeacon.mock.calls[0]![1];
    const text = await blob.text();
    expect(JSON.parse(text).meta).toEqual({ flow: 'recruit' });
    vi.unstubAllGlobals();
  });
});
