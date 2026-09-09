import { describe, expect, it } from 'vitest';
import { derivePhrase } from './glance';

describe('derivePhrase (정성 진척 언어 — %는 보조)', () => {
  it('returns notStarted for a zero-story epic', () => {
    expect(derivePhrase(0, 0)).toBe('notStarted');
  });
  it('returns notStarted for 0% even with stories present', () => {
    expect(derivePhrase(0, 5)).toBe('notStarted');
  });
  it('buckets mid-range progress as underway', () => {
    expect(derivePhrase(45, 10)).toBe('underway');
  });
  it('buckets high progress as almostThere', () => {
    expect(derivePhrase(75, 8)).toBe('almostThere');
  });
  it('buckets near-complete progress as wrappingUp', () => {
    expect(derivePhrase(95, 20)).toBe('wrappingUp');
  });
});

// story #3710(2026-09-09, 페드루 PO 決) — deriveRoadmapStatus/scopeRoadmapEpics/mergeRoadmap
// 테스트를 제거했다. 유일 소비처(load-glance-data.ts의 로드맵 아크 계산)가 죽은 경로였다
// ("갈래" 뷰는 NextMakerScreen이 자기 cursor-모드 fetch로 독립 로드 — grep 전수: flow-
// client.tsx는 loadGlanceData 결과 중 attentionSignals·memberMap만 소비, roadmap 소비 0).
// 그 함수들 자체도 services/glance.ts에서 함께 삭제됐다(아래 참고). RoadmapEpic(→derive-
// flow.ts)·BeFocalStory(→derive-hero-envelope.ts)는 실 소비처가 있어 타입만 남았다.

// story #2224(선생님 정정 2026-07-30) — filterMilestoneEvents/deriveVagueRecency 테스트를
// 제거했다. 유일 소비처(LiveStream, §6 생동 스트림)가 /glance 삭제와 함께 죽은 코드가 됐고,
// 그 함수들 자체도 services/glance.ts에서 함께 삭제됐다(아래 참고).
