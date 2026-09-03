import { describe, test, expect } from 'vitest';
import { parseSitePostApiError } from './api-error';

describe('parseSitePostApiError (story #3368, doc phase0-post-manager-screen-design §4-1)', () => {
  test('알려진 코드(MEDIA_NOT_SUPPORTED_PHASE0) — humanMessageKey가 채워지고 raw도 보존된다', () => {
    const result = parseSitePostApiError({ detail: { code: 'MEDIA_NOT_SUPPORTED_PHASE0', message: 'Phase 0은 미디어 입력을 지원하지 않습니다' } });
    expect(result.humanMessageKey).toBe('errorMediaNotSupported');
    expect(result.raw).toContain('MEDIA_NOT_SUPPORTED_PHASE0');
    expect(result.raw).toContain('미디어');
  });

  test('알려진 코드(SITE_POST_PUBLISH_HUMAN_ONLY)', () => {
    const result = parseSitePostApiError({ detail: { code: 'SITE_POST_PUBLISH_HUMAN_ONLY', message: '글 공개는 휴먼 멤버만 가능합니다' } });
    expect(result.humanMessageKey).toBe('errorPublishHumanOnly');
  });

  test('⭐모르는 코드 — 지어낸 문구로 덮지 않고 서버 원문 메시지를 그대로 fallback에 담는다', () => {
    const result = parseSitePostApiError({ detail: { code: 'SOME_FUTURE_S2_CODE', message: '아직 모르는 에러' } });
    expect(result.humanMessageKey).toBeUndefined();
    expect(result.humanMessageFallback).toBe('아직 모르는 에러');
    expect(result.raw).toContain('SOME_FUTURE_S2_CODE');
  });

  test('detail이 순수 문자열(코드 없음) — message로만 처리, raw에도 실린다', () => {
    const result = parseSitePostApiError({ detail: 'org_id mismatch' });
    expect(result.humanMessageFallback).toBe('org_id mismatch');
    expect(result.raw).toContain('org_id mismatch');
  });

  test('body가 null(파싱 실패) — 빈 문자열 fallback, raw는 null 쌍으로 안전하게 직렬화', () => {
    const result = parseSitePostApiError(null);
    expect(result.humanMessageFallback).toBe('');
    expect(() => JSON.parse(result.raw)).not.toThrow();
  });
});
