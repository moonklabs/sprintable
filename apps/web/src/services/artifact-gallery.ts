/**
 * E-CANVAS 산출물 갤러리(story a15cea4f) — 순수 데이터 계층. 설계 SSOT: doc
 * `artifact-gallery-design`. 스토리 상세 ArtifactSection(인-스토리 증거)과 별개인 발견 표면 —
 * 4축(에픽·스토리·스프린트·문서)으로 산출물을 모아 변천사를 본다. "기능" 축은 데이터 모델에
 * 연결 필드 자체가 없어 미지원(no-fiction — 억지 축을 만들지 않고 UI에 정직 표기).
 */
import type { BeVisualArtifactSummary } from './canvas';

export type GalleryAxis = 'epic' | 'story' | 'sprint' | 'doc';

export const GALLERY_AXES: GalleryAxis[] = ['epic', 'story', 'sprint', 'doc'];

export interface GalleryArtifactSummary {
  id: string;
  title: string;
  latestVersionNumber: number;
  anchorVersion: number | null;
}

export interface GalleryGroup {
  /** 엔티티 id, 무소속 그룹은 'unassigned'. */
  id: string;
  label: string;
  unassigned: boolean;
  artifacts: GalleryArtifactSummary[];
}

interface EntityRef {
  id: string;
  title: string;
}

interface StoryRef {
  id: string;
  title: string;
  sprint_id: string | null;
  epic_id: string | null;
}

export interface GalleryLookups {
  epics: EntityRef[];
  stories: StoryRef[];
  sprints: EntityRef[];
  docs: EntityRef[];
}

function toSummary(a: BeVisualArtifactSummary): GalleryArtifactSummary {
  return { id: a.id, title: a.title, latestVersionNumber: a.latest_version_number, anchorVersion: a.anchor_version };
}

function groupBy(
  artifacts: BeVisualArtifactSummary[],
  entities: EntityRef[],
  keyOf: (a: BeVisualArtifactSummary) => string | null,
  unassignedLabel: string,
): GalleryGroup[] {
  const titleById = new Map(entities.map((e) => [e.id, e.title]));
  const byKey = new Map<string, BeVisualArtifactSummary[]>();
  const unassigned: BeVisualArtifactSummary[] = [];

  for (const a of artifacts) {
    const key = keyOf(a);
    // no-fiction: key가 있어도 해당 엔티티를 못 찾으면(삭제 등) 지어낸 라벨 대신 무소속으로.
    if (!key || !titleById.has(key)) { unassigned.push(a); continue; }
    (byKey.get(key) ?? byKey.set(key, []).get(key)!).push(a);
  }

  const groups: GalleryGroup[] = [...byKey.entries()]
    .map(([id, items]) => ({ id, label: titleById.get(id)!, unassigned: false, artifacts: items.map(toSummary) }))
    .sort((a, b) => b.artifacts.length - a.artifacts.length || a.label.localeCompare(b.label));

  if (unassigned.length > 0) {
    groups.push({ id: 'unassigned', label: unassignedLabel, unassigned: true, artifacts: unassigned.map(toSummary) });
  }
  return groups;
}

/**
 * 축별 그룹핑. 에픽·스프린트는 간접 유도(artifact.story_id → Story.epic_id/sprint_id 1홉,
 * FE join) — 에이전트/휴먼 저작 산출물은 항상 스토리에 앵커되고 artifact.epic_id를 직접
 * 지정하는 경우가 드물어(story ca37b2b0 — dev 실데이터 전건 epic_id NULL), 직접 FK를
 * 우선하되 없으면 스토리 경유로 유도한다. doc/story 축은 artifact의 직접 FK만(스토리 경유가
 * 의미 없음). story_id가 NULL이거나 해당 story의 epic_id/sprint_id가 NULL이면 무소속.
 */
export function buildGalleryGroups(
  axis: GalleryAxis,
  artifacts: BeVisualArtifactSummary[],
  lookups: GalleryLookups,
  unassignedLabel: string,
): GalleryGroup[] {
  if (axis === 'doc') return groupBy(artifacts, lookups.docs, (a) => a.doc_id, unassignedLabel);
  if (axis === 'story') {
    const storyRefs: EntityRef[] = lookups.stories.map((s) => ({ id: s.id, title: s.title }));
    return groupBy(artifacts, storyRefs, (a) => a.story_id, unassignedLabel);
  }
  if (axis === 'epic') {
    const epicIdByStoryId = new Map(lookups.stories.map((s) => [s.id, s.epic_id]));
    return groupBy(
      artifacts, lookups.epics,
      (a) => a.epic_id ?? (a.story_id ? epicIdByStoryId.get(a.story_id) ?? null : null),
      unassignedLabel,
    );
  }
  // sprint: story_id → sprint_id 1홉 join.
  const sprintIdByStoryId = new Map(lookups.stories.map((s) => [s.id, s.sprint_id]));
  return groupBy(
    artifacts, lookups.sprints,
    (a) => (a.story_id ? sprintIdByStoryId.get(a.story_id) ?? null : null),
    unassignedLabel,
  );
}
