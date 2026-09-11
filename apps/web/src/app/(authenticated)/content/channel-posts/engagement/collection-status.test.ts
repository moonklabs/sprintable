// story #3805(Phase3·3-1·PR 4 후속, 유나 判定 2026-09-11 12:48Z) — 「답글 구분
// 불가」는 「수집 안 됨」(last_collected_at=null) 상태엔 안 붙는다(모순 문장 방지).
import { describe, expect, it } from 'vitest';
import { shouldShowReplyDetectionUnavailable } from './collection-status';

describe('shouldShowReplyDetectionUnavailable', () => {
  it('뮤테이션 대상 — 최소 한 번 수집 성공(last_collected_at 有) + 플래그 有 = true', () => {
    expect(shouldShowReplyDetectionUnavailable({
      reply_detection_unavailable: true, last_collected_at: '2026-09-11T12:00:00Z',
    })).toBe(true);
  });

  it('뮤테이션 대상 — 수집 안 됨(last_collected_at=null) + 플래그 有 = false(모순 문장 방지)', () => {
    expect(shouldShowReplyDetectionUnavailable({
      reply_detection_unavailable: true, last_collected_at: null,
    })).toBe(false);
  });

  it('수집됨 + 플래그 無 = false', () => {
    expect(shouldShowReplyDetectionUnavailable({
      reply_detection_unavailable: false, last_collected_at: '2026-09-11T12:00:00Z',
    })).toBe(false);
  });
});
