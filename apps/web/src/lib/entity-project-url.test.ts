import { describe, expect, it } from 'vitest';
import { resolveScopedEntityHref, storyBoardUrl, goalUrl, sprintUrl, assetStorageUrl } from './entity-project-url';

describe('storyBoardUrl / goalUrl / sprintUrl / assetStorageUrl — ws/proj-scoped 착지', () => {
  it('story — /{ws}/{proj}/flow?story={id}(story #4327 — 지금 이름 flow로 바로 · 옛 /board는 proxy 리다이렉트 왕복이 한 번 더 붙었다)', () => {
    expect(storyBoardUrl('moonklabs', 'proj-a', 'story-1')).toBe('/moonklabs/proj-a/flow?story=story-1');
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

// story #4253(유나 4612 비차단 · PO 14:28Z) — 폴백은 bare로 못 나간다: 필수 withProject로 감싼다(항목 프로젝트 → `?p=`).
const toC = (h: string) => `${h}${h.includes('?') ? '&' : '?'}p=proj-C`;

describe('resolveScopedEntityHref — 선조회 성공/실패 갈래(PO 08-14 ④ 폴백 원칙)', () => {
  it('orgSlug+projectSlug 둘 다 있으면 스코프드 URL을 짓는다(뷰어 현재 프로젝트 추측 안 거침)', () => {
    const href = resolveScopedEntityHref(
      { orgSlug: 'moonklabs', projectSlug: 'proj-a' },
      '/flow?story=story-1',
      (ws, proj) => storyBoardUrl(ws, proj, 'story-1'),
      toC,
    );
    expect(href).toBe('/moonklabs/proj-a/flow?story=story-1');
  });

  it('⭐선조회 자체가 null(미도착/실패)이면 폴백 경로를 항목 프로젝트로 감싼다(bare 금지)', () => {
    const href = resolveScopedEntityHref(null, '/flow?story=story-1', (ws, proj) => storyBoardUrl(ws, proj, 'story-1'), toC);
    expect(href).toBe('/flow?story=story-1&p=proj-C');
  });

  it('⭐projectSlug가 null(옛 미백필 프로젝트)이면 폴백 경로 + 항목 프로젝트(?p=)', () => {
    const href = resolveScopedEntityHref(
      { orgSlug: 'moonklabs', projectSlug: null },
      '/goals/epic-1',
      (ws, proj) => goalUrl(ws, proj, 'epic-1'),
      toC,
    );
    expect(href).toBe('/goals/epic-1?p=proj-C');
  });

  it('orgSlug가 빈 문자열(계약 위반·방어)이면 폴백 경로 + 항목 프로젝트', () => {
    const href = resolveScopedEntityHref(
      { orgSlug: '', projectSlug: 'proj-a' },
      '/storage?asset=asset-1',
      (ws, proj) => assetStorageUrl(ws, proj, 'asset-1'),
      toC,
    );
    expect(href).toBe('/storage?asset=asset-1&p=proj-C');
  });

  it('bare 폴백 자체가 null이면(원래도 갈 곳 없던 타입) null을 그대로 준다(지어내지 않음)', () => {
    const href = resolveScopedEntityHref(null, null, (ws, proj) => goalUrl(ws, proj, 'epic-1'), toC);
    expect(href).toBeNull();
  });
});
