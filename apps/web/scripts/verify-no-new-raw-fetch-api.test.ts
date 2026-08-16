import { describe, expect, it } from 'vitest';
import { EXEMPT_FILES, GRANDFATHER_BASELINE, extractRawFetchApiCalls } from './verify-no-new-raw-fetch-api';

describe('extractRawFetchApiCalls — 순수 판정 함수(AC4)', () => {
  it('/api/ 문자열 리터럴을 인자로 받는 raw fetch()를 잡는다', () => {
    const hits = extractRawFetchApiCalls(`fetch('/api/me')`, 'some-file.ts');
    expect(hits).toEqual([{ file: 'some-file.ts', urlPrefix: '/api/me', key: 'some-file.ts::/api/me' }]);
  });

  it('템플릿 리터럴의 ${} 보간 이전 고정 접두사만 키로 남긴다(라인 드리프트에 안 흔들림)', () => {
    const hits = extractRawFetchApiCalls('fetch(`/api/team-members/${agentId}`)', 'f.ts');
    expect(hits[0]!.urlPrefix).toBe('/api/team-members/');
  });

  it('fetchWithAuth(...)는 안 잡는다(단어 경계가 WithAuth 접두를 배제)', () => {
    const hits = extractRawFetchApiCalls(`fetchWithAuth('/api/me')`, 'f.ts');
    expect(hits).toEqual([]);
  });

  it('rateLimitedFetch(...)도 안 잡는다(다른 관심사 — rate-limit, 인증 재시도 아님)', () => {
    const hits = extractRawFetchApiCalls(`rateLimitedFetch('/api/me')`, 'f.ts');
    expect(hits).toEqual([]);
  });

  it('/api/가 아닌 fetch(외부 URL 등)는 안 잡는다', () => {
    const hits = extractRawFetchApiCalls(`fetch('https://example.com/x')`, 'f.ts');
    expect(hits).toEqual([]);
  });

  it('EXEMPT_FILES에 등재된 파일은 raw fetch가 있어도 전부 무시한다', () => {
    const hits = extractRawFetchApiCalls(`fetch('/api/auth/verify-email')`, 'app/verify-email/page.tsx');
    expect(hits).toEqual([]);
  });

  // ⭐양성대조(AC3) — story #2689 실사고(raw fetch가 401을 재시도 없이 삼킴)와 동형 모사:
  // 새 파일에 raw fetch('/api/...')가 추가되면 정확히 이 판정 함수가 잡는지 고정한다.
  it('#2689 실사고 픽스처 — 새 파일의 raw fetch(\'/api/...\')를 놓치지 않는다', () => {
    const hits = extractRawFetchApiCalls(
      `const res = await fetch('/api/assets/storage-usage');\nif (!res.ok) return;`,
      'components/storage/some-new-widget.tsx',
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]!.urlPrefix).toBe('/api/assets/storage-usage');
  });
});

// story #2691 — 선언된 baseline 크기를 고정해 조용한 증감(리뷰 없는 추가/삭제)을 막는다
// (verify-no-i18n-phrase-collision.ts의 GRANDFATHER_BASELINE_COUNT_TEST와 동일 관례).
describe('GRANDFATHER_BASELINE_COUNT_TEST — 41번째부터는 review 없이 조용히 못 늘어난다(관례 재사용)', () => {
  it('story #2691 착수 시점 스냅샷은 정확히 282건이다', () => {
    expect(GRANDFATHER_BASELINE.size).toBe(282);
  });

  it('EXEMPT_FILES는 8개 파일(pre-auth·공개 라우트·primitive 구현) 그대로다', () => {
    expect(EXEMPT_FILES.size).toBe(8);
  });
});
