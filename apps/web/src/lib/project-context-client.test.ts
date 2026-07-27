// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TAB_PROJECT_STORAGE_KEY, resolveEffectiveProjectId } from './project-context-client';

describe('resolveEffectiveProjectId (hydrated 게이팅 — SSR/첫 CSR 렌더 divergence 방지, 2026-07-11 라이브 재현)', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });
  afterEach(() => {
    window.sessionStorage.clear();
  });

  it('prefers a valid urlProjectId regardless of hydrated state', () => {
    const accessible = new Set(['p1']);
    expect(resolveEffectiveProjectId('p1', 'server-id', accessible, false)).toBe('p1');
    expect(resolveEffectiveProjectId('p1', 'server-id', accessible, true)).toBe('p1');
  });

  it('ignores sessionStorage when hydrated=false, even if a valid stored value exists (SSR-consistent first render)', () => {
    window.sessionStorage.setItem(TAB_PROJECT_STORAGE_KEY, 'stored-id');
    const accessible = new Set(['stored-id', 'server-id']);
    expect(resolveEffectiveProjectId(null, 'server-id', accessible, false)).toBe('server-id');
  });

  it('uses sessionStorage once hydrated=true (backstop restored after the settle tick)', () => {
    window.sessionStorage.setItem(TAB_PROJECT_STORAGE_KEY, 'stored-id');
    const accessible = new Set(['stored-id', 'server-id']);
    expect(resolveEffectiveProjectId(null, 'server-id', accessible, true)).toBe('stored-id');
  });

  it('defaults hydrated to true when the 4th arg is omitted (backward compatible call sites)', () => {
    window.sessionStorage.setItem(TAB_PROJECT_STORAGE_KEY, 'stored-id');
    const accessible = new Set(['stored-id', 'server-id']);
    expect(resolveEffectiveProjectId(null, 'server-id', accessible)).toBe('stored-id');
  });

  it('falls back to serverProjectId when neither URL nor an accessible stored value exists', () => {
    const accessible = new Set(['server-id']);
    expect(resolveEffectiveProjectId(null, 'server-id', accessible, true)).toBe('server-id');
  });

  it('rejects an inaccessible stored value even when hydrated', () => {
    window.sessionStorage.setItem(TAB_PROJECT_STORAGE_KEY, 'not-a-member-project');
    const accessible = new Set(['server-id']);
    expect(resolveEffectiveProjectId(null, 'server-id', accessible, true)).toBe('server-id');
  });
});

describe('resolveEffectiveProjectId — pathProjectId 최우선 (story #2093, 직접 URL 진입 시 top-bar 칩이 계정 상태의 다른 프로젝트를 그리던 회귀)', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });
  afterEach(() => {
    window.sessionStorage.clear();
  });

  it('직접 URL 진입(?p= 없음) — pathProjectId가 계정 상태(serverProjectId)보다 우선한다', () => {
    const accessible = new Set(['server-id']); // 계정 멤버십엔 path-project가 없을 수 있다(cross-org)
    expect(resolveEffectiveProjectId(null, 'server-id', accessible, true, 'path-id')).toBe('path-id');
  });

  it('pathProjectId는 accessibleIds 체크를 받지 않는다(proxy.ts가 이미 서버측에서 resolve로 검증한 값)', () => {
    const accessible = new Set(['server-id']); // path-id가 이 집합에 없어도(cross-org) 채택돼야 한다
    expect(resolveEffectiveProjectId(null, 'server-id', accessible, false, 'path-id')).toBe('path-id');
  });

  it('pathProjectId가 ?p=/sessionStorage보다도 우선한다(경로가 유일한 정본)', () => {
    window.sessionStorage.setItem(TAB_PROJECT_STORAGE_KEY, 'stored-id');
    const accessible = new Set(['stored-id', 'url-id', 'path-id']);
    expect(resolveEffectiveProjectId('url-id', 'server-id', accessible, true, 'path-id')).toBe('path-id');
  });

  it('pathProjectId가 없는(flat 라우트) 경우엔 기존 ?p= 우선순위 체인이 그대로 동작한다', () => {
    const accessible = new Set(['url-id', 'server-id']);
    expect(resolveEffectiveProjectId('url-id', 'server-id', accessible, true, undefined)).toBe('url-id');
  });
});
