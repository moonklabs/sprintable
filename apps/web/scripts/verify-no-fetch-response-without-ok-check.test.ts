import { describe, expect, it } from 'vitest';
import { findFetchOkViolations, runSelfTest } from './verify-no-fetch-response-without-ok-check';

describe('findFetchOkViolations (story #3688 regression guard)', () => {
  it('flags 체이닝 형(.then(r => r.json()), .ok 검사 없음)', () => {
    const hits = findFetchOkViolations(
      "function f() { return fetchWithAuth('/api/x').then((r) => r.json()); }",
      'f.ts',
    );
    expect(hits).toHaveLength(1);
  });

  it('flags await+분리 형(.ok 검사 없음)', () => {
    const hits = findFetchOkViolations(
      "async function f() {\n  const res = await fetchWithAuth('/api/x');\n  return await res.json();\n}",
      'f.ts',
    );
    expect(hits).toHaveLength(1);
  });

  it('does not flag await+분리 형 with .ok check', () => {
    const hits = findFetchOkViolations(
      "async function f() {\n  const res = await fetchWithAuth('/api/x');\n  if (!res.ok) throw new Error('x');\n  return await res.json();\n}",
      'f.ts',
    );
    expect(hits).toHaveLength(0);
  });

  it('does not flag 체이닝 형 with an intermediate .ok-checking step', () => {
    const hits = findFetchOkViolations(
      "function f() { return fetchWithAuth('/api/x').then((r) => { if (!r.ok) throw new Error('x'); return r.json(); }); }",
      'f.ts',
    );
    expect(hits).toHaveLength(0);
  });

  it('does not flag raw fetch() (다른 가드 verify-no-new-raw-fetch-api.ts 관할)', () => {
    const hits = findFetchOkViolations(
      "async function f() {\n  const res = await fetch('/api/x');\n  return await res.json();\n}",
      'f.ts',
    );
    expect(hits).toHaveLength(0);
  });

  it('키는 «파일::트림된 줄 텍스트» — 줄 번호가 아니다(무관 줄 삽입에도 안 흔들림)', () => {
    const a = findFetchOkViolations(
      "async function f() {\n  const res = await fetchWithAuth('/api/x');\n  return await res.json();\n}",
      'f.ts',
    );
    const b = findFetchOkViolations(
      "// 무관 주석\nconst UNUSED = 1;\nasync function f() {\n  const res = await fetchWithAuth('/api/x');\n  return await res.json();\n}",
      'f.ts',
    );
    expect(a[0]?.key).toBe(b[0]?.key);
  });

  it('같은 파일 안 중복 히트는 한 번만 센다(같은 줄이 두 패턴 다 매칭될 일은 없지만 방어적 dedupe)', () => {
    const hits = findFetchOkViolations(
      "function f() { return fetchWithAuth('/api/x').then((r) => r.json()); }\n" +
        "function g() { return fetchWithAuth('/api/x').then((r) => r.json()); }",
      'f.ts',
    );
    // 서로 다른 줄이라 키가 달라 2건 그대로 — dedupe는 "완전히 같은 키"에서만 작동함을 확인.
    expect(hits).toHaveLength(2);
  });
});

describe('runSelfTest (story #3688)', () => {
  it('자체 픽스처 대조를 통과한다', () => {
    expect(runSelfTest()).toBe(true);
  });
});
