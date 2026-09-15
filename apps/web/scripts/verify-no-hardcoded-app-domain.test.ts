import { describe, expect, it } from 'vitest';
import { findHardcodedAppDomain, scanRepository } from './verify-no-hardcoded-app-domain';

describe('findHardcodedAppDomain — 단위(패턴 자체)', () => {
  it('리터럴 sprintable.app을 잡는다(양성대조 — story #3905가 실제로 겪은 모양)', () => {
    const hits = findHardcodedAppDomain("<p>sprintable.app/{orgSlug || '...'}</p>");
    expect(hits.length).toBe(1);
  });

  it('getPublicAppHost() 호출은 안 잡는다(음성대조)', () => {
    const hits = findHardcodedAppDomain("<p>{getPublicAppHost()}/{orgSlug || '...'}</p>");
    expect(hits.length).toBe(0);
  });

  it('실 도메인(sprintable.ai)은 이 가드의 관심사가 아니다(다른 리터럴)', () => {
    const hits = findHardcodedAppDomain("const LLMS_URL = 'https://app.sprintable.ai/llms.txt';");
    expect(hits.length).toBe(0);
  });
});

describe('story #3905 회귀가드 — 전수 스캔 0건', () => {
  // story #3902 패턴(공유머신 부하로 vitest 기본 5000ms 초과 가능) 재사용 — 여유 타임아웃.
  it('새 FAIL은 없다(#3905가 알려진 2곳을 전부 고친 뒤의 clean-slate)', () => {
    expect(scanRepository()).toEqual([]);
  }, 1000);
});
