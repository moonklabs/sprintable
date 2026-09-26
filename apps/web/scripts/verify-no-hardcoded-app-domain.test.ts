import { describe, expect, it } from 'vitest';
import { findHardcodedAppDomain, scanRepository } from './verify-no-hardcoded-app-domain';
import { measureFsReads } from './test-utils/fs-work';

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
  // story #4333 — 시한은 기본(행 가드 · 벽시계 예산 폐기). 일의 양은 결정적으로 — 한 스캔에서 같은 파일을 두 번 읽으면 RED(measureFsReads).
  it('새 FAIL은 없다(#3905가 알려진 2곳을 전부 고친 뒤의 clean-slate)', () => {
    const { result: __scan, maxPerFile, files: __filesRead } = measureFsReads(() => scanRepository());
    expect(maxPerFile.count, `${maxPerFile.file} — 한 스캔에서 두 번 이상 읽음(일이 늘었다)`).toBeLessThanOrEqual(1);
    expect(__filesRead, '읽기를 실제로 셌다(헛돌지 않게)').toBeGreaterThan(0);
    expect(__scan).toEqual([]);
  });
});
