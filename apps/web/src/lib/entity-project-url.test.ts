import { describe, expect, it } from 'vitest';
import { resolveScopedEntityHref, storyBoardUrl, goalUrl, sprintUrl, assetStorageUrl } from './entity-project-url';

describe('storyBoardUrl / goalUrl / sprintUrl / assetStorageUrl — ws/proj-scoped 착지', () => {
  it('story — /{ws}/{proj}/board?story={id}(next.config.ts redirects()가 flow로 자동 병합)', () => {
    expect(storyBoardUrl('moonklabs', 'proj-a', 'story-1')).toBe('/moonklabs/proj-a/board?story=story-1');
  });

  it('epic(목표) — /{ws}/{proj}/goals/{id} 경로 파라미터', () => {
    expect(goalUrl('moonklabs', 'proj-a', 'epic-1')).toBe('/moonklabs/proj-a/goals/epic-1');
  });

  it('sprint — /{ws}/{proj}/sprints?id={id} 딥링크 쿼리', () => {
    expect(sprintUrl('moonklabs', 'proj-a', 'sprint-1')).toBe('/moonklabs/proj-a/sprints?id=sprint-1');
  });

  it('asset — /{ws}/{proj}/storage?asset={id} 딥링크 쿼리', () => {
    expect(assetStorageUrl('moonklabs', 'proj-a', 'asset-1')).toBe('/moonklabs/proj-a/storage?asset=asset-1');
  });
});

describe('resolveScopedEntityHref — 선조회 성공/실패 갈래(PO 08-14 ④ 폴백 원칙)', () => {
  it('orgSlug+projectSlug 둘 다 있으면 스코프드 URL을 짓는다(뷰어 현재 프로젝트 추측 안 거침)', () => {
    const href = resolveScopedEntityHref(
      { orgSlug: 'moonklabs', projectSlug: 'proj-a' },
      '/board?story=story-1',
      (ws, proj) => storyBoardUrl(ws, proj, 'story-1'),
    );
    expect(href).toBe('/moonklabs/proj-a/board?story=story-1');
  });

  it('선조회 자체가 null(미도착/실패)이면 bare 폴백을 그대로 준다(더 나빠지지 않음)', () => {
    const href = resolveScopedEntityHref(null, '/board?story=story-1', (ws, proj) => storyBoardUrl(ws, proj, 'story-1'));
    expect(href).toBe('/board?story=story-1');
  });

  it('projectSlug가 null(옛 미백필 프로젝트)이면 bare 폴백으로 우아하게 떨어진다(#2168과 동형)', () => {
    const href = resolveScopedEntityHref(
      { orgSlug: 'moonklabs', projectSlug: null },
      '/goals/epic-1',
      (ws, proj) => goalUrl(ws, proj, 'epic-1'),
    );
    expect(href).toBe('/goals/epic-1');
  });

  it('orgSlug가 빈 문자열(계약 위반·방어)이면 bare 폴백으로 떨어진다', () => {
    const href = resolveScopedEntityHref(
      { orgSlug: '', projectSlug: 'proj-a' },
      '/storage?asset=asset-1',
      (ws, proj) => assetStorageUrl(ws, proj, 'asset-1'),
    );
    expect(href).toBe('/storage?asset=asset-1');
  });

  it('bare 폴백 자체가 null이면(원래도 갈 곳 없던 타입) null을 그대로 준다(지어내지 않음)', () => {
    const href = resolveScopedEntityHref(null, null, (ws, proj) => goalUrl(ws, proj, 'epic-1'));
    expect(href).toBeNull();
  });
});
