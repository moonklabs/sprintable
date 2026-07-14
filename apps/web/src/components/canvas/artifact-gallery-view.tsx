'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Frame } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import {
  adaptArtifactDetail, getArtifactVersionDetail,
  type ArtifactFormat, type BeVisualArtifactSummary, type BeArtifactVersionSummary,
} from '@/services/canvas';
import {
  buildGalleryGroups, GALLERY_AXES,
  type GalleryAxis, type GalleryGroup, type GalleryLookups,
} from '@/services/artifact-gallery';
import { type GalleryTimelineVersion } from './artifact-gallery-timeline';
import { ArtifactThumbnail } from './artifact-thumbnail';
import { ArtifactExpandDialog } from './artifact-expand-dialog';

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

interface StoryListItem { id: string; title: string; sprint_id: string | null; epic_id: string | null }
interface EpicListItem { id: string; title: string }
interface SprintListItem { id: string; title: string }
interface DocListItem { id: string; title: string }

/**
 * story ca37b2b0 — stories lookup은 artifacts 응답에 실제로 등장하는 story_id만 배치 조회
 * (BE #2131 `ids` 파라미터)로 전환. 기존 `limit=100` 전량 fetch는 프로젝트에 스토리가 100개
 * 넘으면 최신 스토리가 잘려나가 에픽/스프린트 축이 무소속으로 오판하는 근본 결함이 있었다.
 * artifacts를 먼저 받아야 어떤 id들이 필요한지 알 수 있어 자연히 2단계 fetch가 되는데,
 * epics/sprints/docs는 artifacts와 무관하니 1단계에서 같이 병렬 처리해 낭비를 최소화한다.
 */
async function fetchGalleryData(projectId: string): Promise<{ artifacts: BeVisualArtifactSummary[]; lookups: GalleryLookups }> {
  const [artifacts, epics, sprints, docs] = await Promise.all([
    // 무쿼리 호출=project-wide(BE가 JWT/API키 컨텍스트의 project_id로 항상 스코프 — 클라 지정
    // 불가 SEC-S8 가드). 기존 프록시 쿼리 forward 그대로라 신규 프록시 0(doc §5).
    fetchJson<BeVisualArtifactSummary[]>('/api/visual-artifacts'),
    fetchJson<EpicListItem[]>(`/api/epics?project_id=${projectId}&limit=100`),
    fetchJson<SprintListItem[]>(`/api/sprints?project_id=${projectId}`),
    fetchJson<DocListItem[]>(`/api/docs?project_id=${projectId}&limit=100`),
  ]);
  const resolvedArtifacts = artifacts ?? [];
  const storyIds = [...new Set(resolvedArtifacts.map((a) => a.story_id).filter((id): id is string => id != null))];
  // 빈 ids면 호출 자체를 생략(no-fiction — 조회할 대상이 없는데 빈 배치를 쏘지 않는다).
  const stories = storyIds.length > 0
    ? await fetchJson<StoryListItem[]>(`/api/stories?project_id=${projectId}&ids=${storyIds.join(',')}`)
    : [];
  return {
    artifacts: resolvedArtifacts,
    lookups: {
      epics: (epics ?? []).map((e) => ({ id: e.id, title: e.title })),
      stories: (stories ?? []).map((s) => ({ id: s.id, title: s.title, sprint_id: s.sprint_id, epic_id: s.epic_id })),
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

/**
 * story 39313b40 §3 — 카드 그리드. 행 리스트(3d888ba2)를 대체(재사용: ArtifactThumbnail·
 * 크게 보기 모달 — 신규 뷰어/썸네일 컴포넌트 0). 클릭 하나로 바로 모달(변천사는 이제
 * 모달 내부 탭 — 그리드 인라인 펼침 폐지, doc §3 "펼침은 grid reflow 유발" 판정).
 */
function ArtifactCard({
  artifact, axisT, onOpen,
}: {
  artifact: GalleryGroup['artifacts'][number];
  axisT: ReturnType<typeof useTranslations>;
  /** 기본 버전(anchor??latest) 실물 열람. */
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      title={axisT('galleryOpenArtifactAction')}
      className="group flex flex-col overflow-hidden rounded-xl border border-border bg-card text-left transition-colors hover:border-primary/40"
    >
      <ArtifactThumbnail
        artifactId={artifact.id}
        latestVersionNumber={artifact.latestVersionNumber}
        anchorVersion={artifact.anchorVersion}
        className="aspect-[8/5] w-full rounded-none border-0 border-b border-border"
      />
      <span className="min-w-0 truncate px-3 pt-2.5 text-[13px] font-semibold text-foreground">
        {artifact.title}
      </span>
      <div className="flex items-center gap-1.5 px-3 pb-3 pt-1.5">
        {artifact.anchorVersion != null ? (
          <span className="shrink-0 rounded border border-success px-1.5 py-0.5 text-[9px] font-extrabold text-success">
            {axisT('galleryAnchorPill', { version: artifact.anchorVersion })}
          </span>
        ) : null}
        <span className="shrink-0 rounded border border-border bg-muted/60 px-1.5 py-0.5 text-[11px] font-bold tabular-nums text-muted-foreground">
          {axisT('galleryLatestChip', { version: artifact.latestVersionNumber })}
        </span>
      </div>
    </button>
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
  /** story 39313b40 — 변천사는 이제 모달 내 버전 탭(그리드 인라인 펼침 폐지). 모달을 여는
   * 시점에 콘텐츠와 버전 목록을 함께 lazy fetch — 이전 행-펼침 시점의 lazy 트리거를 그대로
   * "모달 오픈 시점"으로 옮긴 것뿐(항목 多 갤러리에서 전량 선-fetch 0 원칙 유지). */
  const [expandTarget, setExpandTarget] = useState<{
    artifactId: string; format: ArtifactFormat; content: string; title: string;
    canvasBounds?: { w: number; h: number } | null; versionNumber: number; versions: GalleryTimelineVersion[];
  } | null>(null);

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
  }, [axis, groups.length]); // eslint-disable-line react-hooks/exhaustive-deps -- 축 전환 시에만 초기화

  const selectedGroup = groups.find((g) => g.id === selectedGroupId) ?? null;

  /**
   * story 3d888ba2(실물 열람) + 39313b40(모달 내 버전 탭) — 콘텐츠와 버전 목록을 함께 lazy
   * fetch(모달 오픈 시점 1회). 갤러리 요약엔 format이 없어(BE 계약상 nodes 파생) 버전 상세를
   * 열 때마다 받아야 한다 — 실패(삭제된 버전 등)면 조용히 아무것도 안 함(no-fiction: 깨진/빈
   * 모달을 여는 것보다 아무 반응 없는 게 정직).
   */
  async function handleOpenArtifact(artifactId: string, versionNumber: number, title: string) {
    const [detail, versionList] = await Promise.all([
      getArtifactVersionDetail(artifactId, versionNumber),
      fetchJson<BeArtifactVersionSummary[]>(`/api/visual-artifacts/${artifactId}/versions`),
    ]);
    if (!detail) return;
    const { artifact, versions } = adaptArtifactDetail(detail);
    const content = versions[0]?.content;
    if (!content) return;
    const mappedVersions: GalleryTimelineVersion[] = (versionList ?? [])
      .slice()
      .sort((a, b) => a.version_number - b.version_number)
      .map((v) => ({ versionNumber: v.version_number, summary: v.summary, isAnchor: v.version_number === artifact.anchor_version }));
    setExpandTarget({
      artifactId, format: artifact.format, content, title,
      canvasBounds: versions[0]?.canvasBounds, versionNumber, versions: mappedVersions,
    });
  }

  const axisLabel = (a: GalleryAxis) => t(`galleryAxis${a[0]!.toUpperCase()}${a.slice(1)}`);

  // story 6d0a0e3a — GROUP BY(축 선택+그룹 목록) 배치를 목업(0d852d24) SSOT대로 좌측 레일에
  // 통합(#2124 이래 우측 상단 탭으로 어긋나 있던 걸 정정). 로직은 완전 무변경 — axis/setAxis·
  // groups·selectedGroupId 전부 그대로, 렌더 "위치"만 옮긴다(AC "배치만 변경").
  const railContent = (
    <>
      <div className="flex flex-wrap gap-0.5 border-b border-border p-1.5">
        {GALLERY_AXES.map((a) => (
          <button
            key={a}
            type="button"
            onClick={() => setAxis(a)}
            className={cn(
              'rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors',
              axis === a ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
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
      <div className="space-y-1.5 p-1.5">
        {groups.map((g) => (
          <button
            key={g.id}
            type="button"
            onClick={() => setSelectedGroupId(g.id)}
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
    </>
  );

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <div className="mb-4">
        <h1 className="text-[20px] font-extrabold tracking-tight text-foreground">{t('galleryTitle')}</h1>
        <p className="mt-0.5 text-xs text-muted-foreground">{t('gallerySubtitle')}</p>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-[200px_1fr]">
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
        <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-[200px_1fr]">
          {/* 반응형(유나 판정 위임 — 목업은 데스크톱만 명시): 좁은 화면=상단 접이식 셀렉터로
           * collapse(네이티브 details/summary — 접근성 기본 제공), lg+=상시 노출 레일 유지. */}
          <details className="rounded-xl border border-border bg-card lg:hidden">
            <summary className="cursor-pointer select-none rounded-xl px-3 py-2.5 text-[13px] font-semibold text-foreground">
              {axisLabel(axis)} · {selectedGroup?.label ?? ''}
            </summary>
            {railContent}
          </details>
          <div className="hidden h-fit rounded-xl border border-border bg-card lg:block">
            {railContent}
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
                <h2 className="mb-3 text-[16px] font-extrabold text-foreground">{selectedGroup.label}</h2>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3.5">
                  {selectedGroup.artifacts.map((artifact) => (
                    <ArtifactCard
                      key={artifact.id}
                      artifact={artifact}
                      axisT={t}
                      onOpen={() => void handleOpenArtifact(artifact.id, artifact.anchorVersion ?? artifact.latestVersionNumber, artifact.title)}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {expandTarget ? (
        <ArtifactExpandDialog
          open={expandTarget !== null}
          onOpenChange={(next) => { if (!next) setExpandTarget(null); }}
          title={expandTarget.title}
          format={expandTarget.format}
          content={expandTarget.content}
          canvasBounds={expandTarget.canvasBounds}
          versions={expandTarget.versions}
          selectedVersion={expandTarget.versionNumber}
          onSelectVersion={(versionNumber) => void handleOpenArtifact(expandTarget.artifactId, versionNumber, expandTarget.title)}
        />
      ) : null}
    </div>
  );
}
