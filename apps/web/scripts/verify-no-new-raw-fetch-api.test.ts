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

// story #3716(카디르 재현, #4062 오탐 1회) — 가드가 주석을 안 벗겨 «주석 속 백틱
// fetch(`/api/…`)»도 실 호출로 셌다(디디의 설명 주석 fetch(`/api/team-members`)가
// CI를 빨갛게 만든 실사고). stripComments()(scripts/i18n-key-parser.js, story #3156
// 통합·#3023 정규식 리터럴 백틱 픽스 포함)를 그대로 재사용해 닫는다.
describe('extractRawFetchApiCalls — 주석·문자열 안 fetch 오탐 봉쇄(story #3716)', () => {
  // (a) 이 케이스는 수정 前엔 RED였다(양성대조) — stripComments 적용 前 코드로 되돌려
  // 재실행하면 이 테스트가 실패하는 것을 실측 확認했다(PR 본문에 grep 근거 남김).
  it('(a) 줄 주석 안의 fetch(`/api/…`)는 안 잡는다 — #4062 실사고 재현', () => {
    const hits = extractRawFetchApiCalls(
      '// story #4062 — /api/team-members·/api/glance/attention 응답을 합친다: fetch(`/api/team-members`)·fetch(`/api/glance/attention`)',
      'components/glance/load-glance-data.ts',
    );
    expect(hits).toEqual([]);
  });

  it('(a-2) 블록 주석 안의 fetch(`/api/…`)도 안 잡는다', () => {
    const hits = extractRawFetchApiCalls(
      '/* 예전엔 fetch(`/api/legacy`)로 불렀으나 지금은 fetchWithAuth로 교체됨 */',
      'components/some-file.ts',
    );
    expect(hits).toEqual([]);
  });

  it('(b) 같은 파일에 주석과 실 코드가 같이 있으면 실 코드만 잡는다', () => {
    const hits = extractRawFetchApiCalls(
      "// fetch(`/api/decoy`) — 이건 주석, 세면 안 됨\nconst res = await fetch('/api/team-members');",
      'components/glance/load-glance-data.ts',
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]!.urlPrefix).toBe('/api/team-members');
  });

  // (c) story #3023 — 정규식 리터럴 안의 백틱을 문자열 델리미터로 오인하면, 그 뒤 파일
  // 전체가 "닫히지 않은 문자열 안"으로 착각돼 진짜 `//` 주석·그 안의 fetch(`/api/…`)를
  // 놓친다(stripComments의 REGEX_LITERAL_CONTEXT_CHARS 분기가 정확히 이걸 닫는다).
  it('(c) 정규식 리터럴 속 백틱(#3023 동형) 뒤에 와도 주석 안 fetch를 여전히 걸러낸다', () => {
    const hits = extractRawFetchApiCalls(
      'const INLINE_CODE_SPAN_RE = /`[^`\\n]*`/g;\n// fetch(`/api/decoy`)',
      'lib/some-parser.ts',
    );
    expect(hits).toEqual([]);
  });

  // (d) 페드루 PO 지적(2026-09-09, 유나 PASS 뒤 fail-open 칸) — (a)~(c)는 전부 «오탐을
  // 막는» 방향이다. 놓치는 방향(fail-open)은 문자열 리터럴 안의 `//`가 «진짜 주석
  // 시작」으로 오인돼 그 뒤(같은 줄의 실 raw fetch)가 통째로 지워지는 경우 — 3716
  // AC1 「문자열 리터럴 안」 낱말이 정확히 이 칸이다.
  it('(d) 문자열 리터럴 안의 `//`(URL 등) 뒤에 와도 같은 줄의 실 raw fetch를 놓치지 않는다(fail-open 방지)', () => {
    const hits = extractRawFetchApiCalls(
      "const cdn = 'https://cdn.example.com//assets'; const r = await fetch('/api/real');",
      'components/some-file.ts',
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]!.urlPrefix).toBe('/api/real');
  });

  it('(d-2) 백틱 템플릿 리터럴 안의 `//`(URL 등) 뒤에 와도 같은 줄의 실 raw fetch를 놓치지 않는다', () => {
    const hits = extractRawFetchApiCalls(
      'const base = `${origin}//x`; const r = await fetch(\'/api/real\');',
      'components/some-file.ts',
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]!.urlPrefix).toBe('/api/real');
  });
});

// story #2691 — 선언된 baseline 크기를 고정해 조용한 증감(리뷰 없는 추가/삭제)을 막는다
// (verify-no-i18n-phrase-collision.ts의 GRANDFATHER_BASELINE_COUNT_TEST와 동일 관례).
describe('GRANDFATHER_BASELINE_COUNT_TEST — 41번째부터는 review 없이 조용히 못 늘어난다(관례 재사용)', () => {
  it('story #2487 후속 — ai-settings.tsx 삭제(BE 라우트 0건, 표면 걷기)로 grandfather 항목 1건 줄어 157건', () => {
    expect(GRANDFATHER_BASELINE.size).toBe(157);
  });

  it('EXEMPT_FILES는 10개 파일(pre-auth·공개 라우트·primitive 구현) 그대로다(story #ab2a503f — app/set-password/confirm/page.tsx 추가, 카디르 QA 처방)', () => {
    expect(EXEMPT_FILES.size).toBe(10);
  });
});
