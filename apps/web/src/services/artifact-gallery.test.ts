import { describe, expect, it } from 'vitest';
import { buildGalleryGroups, GALLERY_AXES, type GalleryLookups } from './artifact-gallery';
import type { BeVisualArtifactSummary } from './canvas';

const UNASSIGNED = '무소속';

function artifact(overrides: Partial<BeVisualArtifactSummary> = {}): BeVisualArtifactSummary {
  return {
    id: 'a1', title: '웰컴 이메일 시안', story_id: null, epic_id: null, doc_id: null,
    source: 'created', latest_version_number: 1, anchor_version: null, created_by: 'm1',
    created_at: '2026-07-13T00:00:00Z', ...overrides,
  };
}

const lookups: GalleryLookups = {
  epics: [{ id: 'e1', title: '온보딩 캠페인' }, { id: 'e2', title: '브랜드 리뉴얼' }],
  stories: [
    { id: 's1', title: '웰컴 이메일', sprint_id: 'sp1', epic_id: 'e2' },
    { id: 's2', title: '랜딩 히어로', sprint_id: null, epic_id: null },
  ],
  sprints: [{ id: 'sp1', title: 'Sprint 24' }, { id: 'sp2', title: 'Sprint 23' }],
  docs: [{ id: 'd1', title: '브랜드 가이드' }],
};

describe('GALLERY_AXES', () => {
  it('exposes exactly the 4 supported axes (feature is not among them — no-fiction)', () => {
    expect(GALLERY_AXES).toEqual(['epic', 'story', 'sprint', 'doc']);
  });
});

describe('buildGalleryGroups — epic axis', () => {
  it('groups artifacts by epic_id, using the real epic title', () => {
    const groups = buildGalleryGroups('epic', [
      artifact({ id: 'a1', epic_id: 'e1' }),
      artifact({ id: 'a2', epic_id: 'e1' }),
      artifact({ id: 'a3', epic_id: 'e2' }),
    ], lookups, UNASSIGNED);
    expect(groups.map((g) => [g.label, g.artifacts.length])).toEqual([
      ['온보딩 캠페인', 2], ['브랜드 리뉴얼', 1],
    ]);
  });

  it('buckets artifacts with no epic_id (or an unresolvable epic_id) as unassigned, last, without fabricating a label', () => {
    const groups = buildGalleryGroups('epic', [
      artifact({ id: 'a1', epic_id: 'e1' }),
      artifact({ id: 'a2', epic_id: null }),
      artifact({ id: 'a3', epic_id: 'deleted-epic' }),
    ], lookups, UNASSIGNED);
    expect(groups.at(-1)).toEqual(expect.objectContaining({ id: 'unassigned', label: UNASSIGNED, unassigned: true }));
    expect(groups.at(-1)!.artifacts).toHaveLength(2);
  });

  // story ca37b2b0 — dev 실데이터 전건 artifact.epic_id NULL(story_id는 실림)이라 에픽 탭이
  // 구조적으로 영구 무소속이던 근본원인 회귀가드. 스프린트 축과 동일 수법(1홉 join).
  it('resolves the epic through the artifact\'s story when epic_id is not set directly (스토리 경유 유도)', () => {
    const groups = buildGalleryGroups('epic', [artifact({ story_id: 's1', epic_id: null })], lookups, UNASSIGNED);
    expect(groups).toEqual([expect.objectContaining({ id: 'e2', label: '브랜드 리뉴얼' })]);
  });

  it('prefers a directly-set epic_id over the story-mediated one when both exist', () => {
    const groups = buildGalleryGroups('epic', [artifact({ story_id: 's1', epic_id: 'e1' })], lookups, UNASSIGNED);
    expect(groups).toEqual([expect.objectContaining({ id: 'e1', label: '온보딩 캠페인' })]);
  });

  it('is unassigned when neither the artifact nor its story has an epic (스토리도 무소속 에픽)', () => {
    const groups = buildGalleryGroups('epic', [artifact({ story_id: 's2', epic_id: null })], lookups, UNASSIGNED);
    expect(groups).toEqual([expect.objectContaining({ id: 'unassigned', unassigned: true })]);
  });

  it('is unassigned when the artifact has no story_id at all (independent artifact, no epic to derive)', () => {
    const groups = buildGalleryGroups('epic', [artifact({ story_id: null, epic_id: null })], lookups, UNASSIGNED);
    expect(groups).toEqual([expect.objectContaining({ id: 'unassigned', unassigned: true })]);
  });
});

describe('buildGalleryGroups — story/doc axes (direct FK)', () => {
  it('groups by story_id', () => {
    const groups = buildGalleryGroups('story', [artifact({ story_id: 's1' })], lookups, UNASSIGNED);
    expect(groups).toEqual([expect.objectContaining({ id: 's1', label: '웰컴 이메일' })]);
  });

  it('groups by doc_id', () => {
    const groups = buildGalleryGroups('doc', [artifact({ doc_id: 'd1' })], lookups, UNASSIGNED);
    expect(groups).toEqual([expect.objectContaining({ id: 'd1', label: '브랜드 가이드' })]);
  });
});

describe('buildGalleryGroups — sprint axis (1-hop join via story.sprint_id)', () => {
  it('resolves the sprint through the artifact\'s story, not a direct FK', () => {
    const groups = buildGalleryGroups('sprint', [artifact({ story_id: 's1' })], lookups, UNASSIGNED);
    expect(groups).toEqual([expect.objectContaining({ id: 'sp1', label: 'Sprint 24' })]);
  });

  it('is unassigned when the story itself has no sprint_id', () => {
    const groups = buildGalleryGroups('sprint', [artifact({ story_id: 's2' })], lookups, UNASSIGNED);
    expect(groups).toEqual([expect.objectContaining({ id: 'unassigned', unassigned: true })]);
  });

  it('is unassigned when the artifact has no story_id at all (independent artifact)', () => {
    const groups = buildGalleryGroups('sprint', [artifact({ story_id: null })], lookups, UNASSIGNED);
    expect(groups).toEqual([expect.objectContaining({ id: 'unassigned', unassigned: true })]);
  });
});

describe('buildGalleryGroups — summary fields (no extra fetch needed)', () => {
  it('carries latestVersionNumber and anchorVersion straight from the list_artifacts summary', () => {
    const groups = buildGalleryGroups('epic', [
      artifact({ id: 'a1', epic_id: 'e1', latest_version_number: 3, anchor_version: 2 }),
    ], lookups, UNASSIGNED);
    expect(groups[0]!.artifacts[0]).toEqual({ id: 'a1', title: '웰컴 이메일 시안', latestVersionNumber: 3, anchorVersion: 2 });
  });

  it('anchorVersion is null when nothing has been anchored yet (no fabricated anchor)', () => {
    const groups = buildGalleryGroups('epic', [artifact({ id: 'a1', epic_id: 'e1', anchor_version: null })], lookups, UNASSIGNED);
    expect(groups[0]!.artifacts[0]!.anchorVersion).toBeNull();
  });
});
