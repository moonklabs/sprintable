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
