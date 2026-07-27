// story a539c649(S-route-project) S2 — ws/proj가 path 세그먼트에 항상 박히므로 prod P0(2026-07-14)
// 가 고치던 `?p=` 누락 레이스는 이 함수들의 시그니처 자체에서 구조적으로 소거됐다(#2154 흡수).
import { describe, expect, it } from 'vitest';
import { newDocUrl, docUrl, docsListUrl } from './doc-project-url';

describe('newDocUrl — 신규 문서 생성 직후 이동 URL', () => {
  it('builds a ws/proj-scoped path with new=1 (구조상 project 컨텍스트 소실 불가)', () => {
    expect(newDocUrl('moonklabs', 'proj-a', 'untitled-123')).toBe('/moonklabs/proj-a/docs/untitled-123?new=1');
  });
});

describe('docUrl — 트리에서 기존 문서 선택 이동 URL', () => {
  it('builds a ws/proj-scoped path without the new=1 auto-focus flag', () => {
    expect(docUrl('moonklabs', 'proj-a', 'existing-doc')).toBe('/moonklabs/proj-a/docs/existing-doc');
  });

  it('never carries new=1 (would incorrectly re-trigger new-doc auto-focus for an existing doc)', () => {
    const url = docUrl('moonklabs', 'proj-b', 'existing-doc');
    expect(url).not.toContain('new=1');
  });
});

describe('docsListUrl — not-found 회복 리다이렉트 URL', () => {
  it('points back to the docs list scoped to the current (correct) workspace/project', () => {
    expect(docsListUrl('moonklabs', 'proj-c')).toBe('/moonklabs/proj-c/docs');
  });
});
