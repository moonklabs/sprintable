'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronRight, Frame } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import type { BeVisualArtifactSummary, BeArtifactVersionSummary } from '@/services/canvas';
import {
  buildGalleryGroups, GALLERY_AXES,
  type GalleryAxis, type GalleryGroup, type GalleryLookups,
} from '@/services/artifact-gallery';
import { ArtifactGalleryTimeline, type GalleryTimelineVersion } from './artifact-gallery-timeline';

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: T };
    return json.data ?? null;
  } catch {
    return null;
  }
}

interface StoryListItem { id: string; title: string; sprint_id: string | null }
interface EpicListItem { id: string; title: string }
interface SprintListItem { id: string; title: string }
interface DocListItem { id: string; title: string }

async function fetchGalleryData(projectId: string): Promise<{ artifacts: BeVisualArtifactSummary[]; lookups: GalleryLookups }> {
  const [artifacts, epics, stories, sprints, docs] = await Promise.all([
    // 무쿼리 호출=project-wide(BE가 JWT/API키 컨텍스트의 project_id로 항상 스코프 — 클라 지정
    // 불가 SEC-S8 가드). 기존 프록시 쿼리 forward 그대로라 신규 프록시 0(doc §5).
    fetchJson<BeVisualArtifactSummary[]>('/api/visual-artifacts'),
    fetchJson<EpicListItem[]>(`/api/epics?project_id=${projectId}&limit=100`),
    fetchJson<StoryListItem[]>(`/api/stories?project_id=${projectId}&limit=100`),
    fetchJson<SprintListItem[]>(`/api/sprints?project_id=${projectId}`),
    fetchJson<DocListItem[]>(`/api/docs?project_id=${projectId}&limit=100`),
  ]);
  return {
    artifacts: artifacts ?? [],
    lookups: {
      epics: (epics ?? []).map((e) => ({ id: e.id, title: e.title })),
      stories: (stories ?? []).map((s) => ({ id: s.id, title: s.title, sprint_id: s.sprint_id })),
      sprints: (sprints ?? []).map((s) => ({ id: s.id, title: s.title })),
      docs: (docs ?? []).map((d) => ({ id: d.id, title: d.title })),
    },
  };
}

function GroupListSkeleton() {
  return (
    <div className="space-y-1.5 p-1.5">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="h-9 animate-pulse rounded-lg bg-muted/60" />
      ))}
    </div>
  );
}

function ArtifactRow({
  artifact, axisT, expanded, versions, versionsLoading, onToggle,
}: {
  artifact: GalleryGroup['artifacts'][number];
  axisT: ReturnType<typeof useTranslations>;
  expanded: boolean;
  versions: GalleryTimelineVersion[] | undefined;
  versionsLoading: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="border-t border-border/60 first:border-t-0">
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => { if (e.key === 'Enter') onToggle(); }}
        className="flex cursor-pointer items-center gap-3 px-1 py-3"
      >
        <span className="h-[22px] w-[30px] shrink-0 rounded border border-border bg-muted/50" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-foreground">
          {artifact.title}
        </span>
        {artifact.anchorVersion != null ? (
          <span className="shrink-0 rounded border border-success px-1.5 py-0.5 text-[9px] font-extrabold text-success">
            {axisT('galleryAnchorPill', { version: artifact.anchorVersion })}
          </span>
        ) : null}
        <span className="shrink-0 rounded border border-border bg-muted/60 px-1.5 py-0.5 text-[11px] font-bold tabular-nums text-muted-foreground">
          {axisT('galleryLatestChip', { version: artifact.latestVersionNumber })}
        </span>
        {expanded ? <ChevronDown className="size-3 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3 shrink-0 text-muted-foreground" />}
      </div>
      {expanded ? (
        <div className="pb-4 pl-[41px] pr-1">
          <p className="mb-2 text-[9.5px] tracking-wide text-muted-foreground/70">{axisT('galleryLazyHint')}</p>
          {versionsLoading ? (
            <div className="h-10 animate-pulse rounded bg-muted/50" />
          ) : versions && versions.length > 0 ? (
            <ArtifactGalleryTimeline versions={versions} />
          ) : (
            <p className="text-[11.5px] text-muted-foreground">{axisT('galleryVersionsUnavailable')}</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * E-CANVAS 산출물 갤러리(story a15cea4f) — 스토리 상세 ArtifactSection(인-스토리 증거)과 별개인
 * 발견 표면. 설계 SSOT: doc `artifact-gallery-design`. 4축(에픽·스토리·스프린트·문서)으로 모아
 * 요약 그리드(1콜)를 보여주고, 펼침 시에만 변천사 상세를 lazy load(GET /{id}/versions) — 전량
 * 선fetch 0. "기능" 축은 데이터 모델에 연결 필드가 없어 미지원(no-fiction) — 토글에 비활성
 * 세그먼트로 정직 표기(숨기지 않음).
 */
export function ArtifactGalleryView() {
  const t = useTranslations('canvas');
  const { projectId } = useDashboardContext();
  const [loading, setLoading] = useState(true);
  const [artifacts, setArtifacts] = useState<BeVisualArtifactSummary[]>([]);
  const [lookups, setLookups] = useState<GalleryLookups>({ epics: [], stories: [], sprints: [], docs: [] });
  const [axis, setAxis] = useState<GalleryAxis>('epic');
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [versionsByArtifact, setVersionsByArtifact] = useState<Record<string, GalleryTimelineVersion[]>>({});
  const [versionsLoadingId, setVersionsLoadingId] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      const result = await fetchGalleryData(projectId);
      if (cancelled) return;
      setArtifacts(result.artifacts);
      setLookups(result.lookups);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [projectId]);

  const groups = useMemo(
    () => buildGalleryGroups(axis, artifacts, lookups, t('galleryUnassignedGroup')),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t는 로케일 불변 함수
    [axis, artifacts, lookups],
  );

  useEffect(() => {
    setSelectedGroupId(groups[0]?.id ?? null);
    setExpandedId(null);
  }, [axis, groups.length]); // eslint-disable-line react-hooks/exhaustive-deps -- 축 전환 시에만 초기화

  const selectedGroup = groups.find((g) => g.id === selectedGroupId) ?? null;

  async function handleToggleExpand(artifactId: string) {
    if (expandedId === artifactId) { setExpandedId(null); return; }
    setExpandedId(artifactId);
    if (versionsByArtifact[artifactId]) return;
    setVersionsLoadingId(artifactId);
    const detail = selectedGroup?.artifacts.find((a) => a.id === artifactId);
    const list = await fetchJson<BeArtifactVersionSummary[]>(`/api/visual-artifacts/${artifactId}/versions`);
    const mapped: GalleryTimelineVersion[] = (list ?? [])
      .slice()
      .sort((a, b) => a.version_number - b.version_number)
      .map((v) => ({ versionNumber: v.version_number, summary: v.summary, isAnchor: v.version_number === detail?.anchorVersion }));
    setVersionsByArtifact((cur) => ({ ...cur, [artifactId]: mapped }));
    setVersionsLoadingId(null);
  }

  const axisLabel = (a: GalleryAxis) => t(`galleryAxis${a[0]!.toUpperCase()}${a.slice(1)}`);

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-extrabold tracking-tight text-foreground">{t('galleryTitle')}</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('gallerySubtitle')}</p>
        </div>
        <div className="flex shrink-0 gap-0.5 rounded-lg border border-border bg-muted/40 p-0.5">
          {GALLERY_AXES.map((a) => (
            <button
              key={a}
              type="button"
              onClick={() => setAxis(a)}
              className={cn(
                'rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors',
                axis === a ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {axisLabel(a)}
            </button>
          ))}
          <button
            type="button"
            disabled
            title={t('galleryFeatureAxisUnsupported')}
            className="cursor-not-allowed rounded-md px-2.5 py-1.5 text-xs font-semibold text-muted-foreground/40"
          >
            {t('galleryAxisFeature')}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="grid grid-cols-[200px_1fr] gap-3.5">
          <GroupListSkeleton />
          <div className="h-40 animate-pulse rounded-xl bg-muted/40" />
        </div>
      ) : artifacts.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-border bg-card px-6 py-12 text-center">
          <Frame className="size-6 text-muted-foreground/60" aria-hidden="true" />
          <p className="text-sm font-medium text-foreground">{t('galleryEmptyTitle')}</p>
          <p className="max-w-sm text-xs text-muted-foreground">{t('galleryEmptyHint')}</p>
        </div>
      ) : (
        <div className="grid grid-cols-[200px_1fr] gap-3.5">
          <div className="h-fit rounded-xl border border-border bg-card p-1.5">
            {groups.map((g) => (
              <button
                key={g.id}
                type="button"
                onClick={() => { setSelectedGroupId(g.id); setExpandedId(null); }}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors',
                  selectedGroupId === g.id ? 'bg-muted/70' : 'hover:bg-muted/40',
                )}
              >
                <span className={cn('size-1.5 shrink-0 rounded-full', selectedGroupId === g.id ? 'bg-info' : 'bg-muted-foreground/40')} aria-hidden="true" />
                <span className={cn('min-w-0 flex-1 truncate font-medium', g.unassigned ? 'italic text-muted-foreground' : 'text-foreground')}>
                  {g.label}
                </span>
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{g.artifacts.length}</span>
              </button>
            ))}
          </div>

          <div
            className="overflow-hidden rounded-xl border border-border bg-card px-5 py-4"
            style={{ clipPath: 'polygon(0 0, calc(100% - 22px) 0, 100% 22px, 100% 100%, 0 100%)' }}
          >
            <div className="mb-3 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">{axisLabel(axis)}</div>
            {!selectedGroup || selectedGroup.artifacts.length === 0 ? (
              <p className="py-8 text-center text-[12.5px] text-muted-foreground">{t('galleryGroupEmpty')}</p>
            ) : (
              <>
                <h2 className="mb-2 text-[16px] font-extrabold text-foreground">{selectedGroup.label}</h2>
                {selectedGroup.artifacts.map((artifact) => (
                  <ArtifactRow
                    key={artifact.id}
                    artifact={artifact}
                    axisT={t}
                    expanded={expandedId === artifact.id}
                    versions={versionsByArtifact[artifact.id]}
                    versionsLoading={versionsLoadingId === artifact.id}
                    onToggle={() => void handleToggleExpand(artifact.id)}
                  />
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
