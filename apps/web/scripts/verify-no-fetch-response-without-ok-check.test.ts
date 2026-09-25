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

describe('story #4312 — AST 전환(글자 창 300자 맹점)', () => {
  const count = (src: string) => findFetchOkViolations(src, 'f.tsx').length;
  const LONG = `/* ${'긴 설명 '.repeat(80)} */`;
  const LONG_OPTS = `{ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ${Array.from({ length: 30 }, (_, i) => `k${i}: ${i}`).join(', ')} }) }`;

  it('⭐AC1 — 호출과 읽기 사이에 주석 20줄을 끼워도 판정이 같다(양성 · 음성 둘 다)', () => {
    const pad = Array.from({ length: 20 }, (_, i) => `  // 끼워 넣은 설명 ${i} — 글자 창이면 이만큼 밀린다`).join('\n');
    const bad = (mid: string) => `async function f() {\n  const res = await fetchWithAuth('/api/x');\n${mid}\n  return await res.json();\n}`;
    const good = (mid: string) => `async function f() {\n  const res = await fetchWithAuth('/api/x');\n${mid}\n  if (!res.ok) throw new Error('x');\n  return await res.json();\n}`;
    expect(count(bad(pad))).toBe(count(bad('')));
    expect(count(bad(pad))).toBe(1);
    expect(count(good(pad))).toBe(count(good('')));
    expect(count(good(pad))).toBe(0);
  });

  it('양성 — `.text()` 읽기도 같은 부류', () => {
    expect(count("async function f() {\n  const res = await fetchWithAuth('/api/x');\n  return await res.text();\n}")).toBe(1);
  });

  it('⭐양성 — 검사 없는 읽기가 긴 옵션 · 주석 뒤(300자 밖)에 있어도 잡는다(예전 창은 못 봄)', () => {
    expect(count(`async function f() {\n  const res = await fetchWithAuth('/api/x', ${LONG_OPTS});\n  ${LONG}\n  return await res.json();\n}`)).toBe(1);
  });

  it('⭐음성 — 검사가 긴 주석 뒤(300자 밖)에 있어도 검사로 본다(예전 창은 오탐 · 4670에서 주석을 옮겨 맞춤)', () => {
    expect(count(`async function f() {\n  const res = await fetchWithAuth('/api/x');\n  ${LONG}\n  if (!res.ok) throw new Error('x');\n  return await res.json();\n}`)).toBe(0);
  });

  it('음성 — 옵셔널 체인 `res?.ok`(`.catch(() => null)` 뒤) · `res.status`도 검사다', () => {
    expect(count("async function f() {\n  const res = await fetchWithAuth('/api/x').catch(() => null);\n  if (res?.ok) { const j = await res.json(); return j; }\n}")).toBe(0);
    expect(count("async function f() {\n  const res = await fetchWithAuth('/api/x');\n  if (res.status === 409) return await res.json();\n}")).toBe(0);
  });

  it('음성 — 본문을 먼저 읽고 `res.ok`로 가르는 모양(실패면 그 본문의 에러 문구)은 올바른 소비', () => {
    expect(count("async function f() {\n  const res = await fetchWithAuth('/api/x');\n  const body = await res.json().catch(() => null);\n  if (!res.ok) return body?.error;\n  return body.data;\n}")).toBe(0);
  });

  it('양성 — 검사는 **같은 함수** 안에서만 친다(다른 함수의 같은 이름 검사는 무관)', () => {
    expect(count("async function f() {\n  const res = await fetchWithAuth('/api/x');\n  return await res.json();\n}\nfunction g(res) { return res.ok; }")).toBe(1);
  });

  it('양성 — 같은 이름에 다시 대입하면 구간이 나뉜다(앞 대입의 검사가 뒤 대입을 덮지 않음)', () => {
    expect(count("async function f() {\n  let res = await fetchWithAuth('/api/a');\n  if (!res.ok) throw new Error('a');\n  await res.json();\n  res = await fetchWithAuth('/api/b');\n  return await res.json();\n}")).toBe(1);
    // 거꾸로 — 뒤 대입의 검사가 앞 대입(검사 없음)을 덮지 않음.
    expect(count("async function f() {\n  let res = await fetchWithAuth('/api/a');\n  await res.json();\n  res = await fetchWithAuth('/api/b');\n  if (!res.ok) throw new Error('b');\n  return await res.json();\n}")).toBe(1);
  });

  it('양성 — 바로 읽기 `(await fetchWithAuth(…)).json()`(검사할 자리가 없다 · 예전 regex는 못 봄)', () => {
    expect(count("async function f() { return (await fetchWithAuth('/api/x')).json(); }")).toBe(1);
  });

  it('체이닝 — 콜백 안 검사 유무(블록 본문)', () => {
    expect(count("function f() { return fetchWithAuth('/api/x').then(async (r) => { const j = await r.json(); return j; }); }")).toBe(1);
    expect(count("function f() { return fetchWithAuth('/api/x').then(async (r) => { const j = await r.json(); return r.ok ? j : null; }); }")).toBe(0);
  });
});

describe('runSelfTest (story #3688)', () => {
  it('자체 픽스처 대조를 통과한다', () => {
    expect(runSelfTest()).toBe(true);
  });
});
