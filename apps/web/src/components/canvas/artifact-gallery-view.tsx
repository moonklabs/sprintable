'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { PageFrame } from '@/components/ds/page-frame';
import { PageHead } from '@/components/ds/page-head';
import { Button } from '@/components/ds/button';
import { Chip } from '@/components/ds/chip';
import { EmptyState } from '@/components/ds/empty-state';
import { Skeleton, SkeletonGroup } from '@/components/ds/skeleton';
import { NativeSelect } from '@/components/ds/select';
import { LAYER } from '@/components/ds/layers';
import { ContextMenu, ContextMenuTrigger, MenuContent, MenuItem } from '@/components/ds/menu';
import {
  adaptArtifactDetail, createArtifact, getArtifactVersionDetail,
  type ArtifactFormat, type BeVisualArtifactSummary, type BeArtifactVersionSummary,
} from '@/services/canvas';
import {
  buildGalleryGroups, GALLERY_AXES,
  type GalleryAxis, type GalleryGroup, type GalleryLookups,
} from '@/services/artifact-gallery';
import { type GalleryTimelineVersion } from './artifact-gallery-timeline';
import { ArtifactThumbnail } from './artifact-thumbnail';
import { ArtifactExpandDialog } from './artifact-expand-dialog';
import { ArtifactEditor } from './artifact-editor';
import { StoryPickerDialog } from './story-picker-dialog';
import { ImportArtifactDialog } from './import-artifact-dialog';
import { useToast } from '@/components/ui/toast';
import { useFlatHref } from '@/hooks/use-flat-href';

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
    fetchJson<EpicListItem[]>(`/api/goals?project_id=${projectId}&limit=100`),
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

/** 4910 — 갤러리 틀 한 곳: 위 막대 제목(`TopBarSlot` — 모든 갈래에서 그린다) + 한 쪽 틀(`PageFrame wide`) + 머리(설명 + 개수 + «그리기 · 가져오기» 늘). 본문에 제목(h1)은 없다. */
const galleryTitle = (label: string) => <h1 className="text-sm font-medium">{label}</h1>;

/** 카드 얼굴 · 썸네일 우물 · 바탕 칸의 층 — 층 표 이름 그대로(styles/layer-rule.test.ts가 같은 이름과 층 사이 간격을 지킨다). */
export const ARTIFACT_CARD_FACE = LAYER.rowOthers;
export const ARTIFACT_CARD_WELL = LAYER.well;
export const ARTIFACT_PANEL = LAYER.panel;

/** 카드 격자 칸 수: 폰 2 · sm 3 · lg 4(눌림 44 이상을 지키며 한 화면에 더 많이 — 4910 시안). */
const GALLERY_GRID = 'grid grid-cols-2 gap-3.5 sm:grid-cols-3 lg:grid-cols-4';

function GalleryGridSkeleton({ label }: { label: string }) {
  return (
    <SkeletonGroup label={label} className={GALLERY_GRID}>
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className={cn('overflow-hidden rounded-ds-panel border border-ds-line', LAYER.rowOthers)}>
          <div className={cn('p-3', LAYER.well)}><Skeleton className="aspect-[8/5] w-full" /></div>
          <div className="space-y-2 p-3">
            <Skeleton variant="text" className="w-3/4" />
            <Skeleton variant="text" size="small" className="w-1/2" />
          </div>
        </div>
      ))}
    </SkeletonGroup>
  );
}

/**
 * story 39313b40 §3 — 카드 그리드. 행 리스트(3d888ba2)를 대체(재사용: ArtifactThumbnail·
 * 크게 보기 모달 — 신규 뷰어/썸네일 컴포넌트 0). 클릭 하나로 바로 모달(변천사는 이제
 * 모달 내부 탭 — 그리드 인라인 펼침 폐지, doc §3 "펼침은 grid reflow 유발" 판정).
 *
 * 4910 — 다시 지음: 카드 얼굴 = 글 줄 층(`LAYER.rowOthers`, 내용 칸 위) · 썸네일 칸 = 한 단 더 들어간 우물(`LAYER.well`) · 칩은 ds Chip(정본 = done · 그 밖은 중립) ·
 * 데스크톱 손길: 우클릭 메뉴 = 이 카드에 «있는» 두 동작(산출물 열기 · 상세 페이지로) — 새 동작 0, 같은 두 동작은 카드의 단추 · 링크로도 늘 닿는다(우클릭 전용 동작 0).
 */
function ArtifactCard({
  artifact, axisT, onOpen,
}: {
  artifact: GalleryGroup['artifacts'][number];
  axisT: ReturnType<typeof useTranslations>;
  /** 기본 버전(anchor??latest) 실물 열람. */
  onOpen: () => void;
}) {
  const flatHref = useFlatHref(); // story #4231 4차 B — 옛 자원 경로(flat 목적지)에 프로젝트
  const router = useRouter();
  const detailHref = flatHref(`/artifacts/${artifact.id}`);
  return (
    // story #3378(결함·customer-zero, 선생님 실사용) — 카드 전체가 <button>이라 크게 보기
    // 다이얼로그 말고는 갈 곳이 없었다. <a>는 <button> 안에 못 들어가(무효 HTML) 바깥 컨테이너는 div,
    // 썸네일만 다이얼로그를 여는 button, 제목 + 메타는 실제 <Link>로 상세 페이지에 간다.
    // 유나 design verdict(ad31d9449) — 배지행도 제목 Link 안에 둬서 «죽은 클릭 면적 0».
    <ContextMenu>
      <ContextMenuTrigger
        data-testid="artifact-card"
        className={cn('group flex flex-col overflow-hidden rounded-ds-panel border border-ds-line transition-colors hover:bg-ds-surface', ARTIFACT_CARD_FACE)}
      >
        <div className={cn('p-3', ARTIFACT_CARD_WELL)}>
          <button
            type="button"
            onClick={onOpen}
            title={axisT('galleryOpenArtifactAction')}
            aria-label={`${axisT('galleryOpenArtifactAction')} · ${artifact.title}`}
            className="block min-h-ds-touch w-full rounded-ds-control text-left outline-none focus-visible:ring-2 focus-visible:ring-ds-action"
          >
            <ArtifactThumbnail
              artifactId={artifact.id}
              latestVersionNumber={artifact.latestVersionNumber}
              anchorVersion={artifact.anchorVersion}
              className="aspect-[8/5] w-full rounded-ds-control border border-ds-line"
            />
          </button>
        </div>
        <Link
          href={detailHref}
          title={axisT('galleryOpenDetailAction')}
          className="flex min-h-ds-touch flex-col gap-2 px-3 pt-2.5 pb-3 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ds-action"
        >
          <span className="min-w-0 truncate text-ds-body font-semibold text-ds-ink">{artifact.title}</span>
          <span className="flex flex-wrap items-center gap-1.5 no-underline">
            {artifact.anchorVersion != null ? (
              <Chip tone="done">{axisT('galleryAnchorPill', { version: artifact.anchorVersion })}</Chip>
            ) : null}
            <Chip>{axisT('galleryLatestChip', { version: artifact.latestVersionNumber })}</Chip>
            {/* story #2724(2026-08-17, 페드루 PO 판정) — 카드 레벨 미연결 배지. 그룹 라벨(축 기준)과는 다른 축의 정보(story_id·doc_id 원자값 기준)라 중복 아님. */}
            {artifact.unlinked ? <Chip className="ml-auto">{axisT('galleryUnlinkedBadge')}</Chip> : null}
          </span>
        </Link>
      </ContextMenuTrigger>
      <MenuContent>
        <MenuItem icon="open_in_full" onClick={onOpen}>{axisT('galleryOpenArtifactAction')}</MenuItem>
        <MenuItem icon="open_in_new" onClick={() => router.push(detailHref)}>{axisT('galleryOpenDetailAction')}</MenuItem>
      </MenuContent>
    </ContextMenu>
  );
}

/**
 * E-CANVAS 산출물 갤러리(story a15cea4f) — 스토리 상세 ArtifactSection(인-스토리 증거)과 별개인
 * 발견 표면. 설계 SSOT: doc `artifact-gallery-design`. 4축(에픽·스토리·스프린트·문서)으로 모아
 * 요약 그리드(1콜)를 보여주고, 펼침 시에만 변천사 상세를 lazy load(GET /{id}/versions) — 전량
 * 선fetch 0. "기능" 축은 데이터 모델에 연결 필드가 없어 미지원(no-fiction) — 토글에 비활성
 * 세그먼트로 정직 표기(숨기지 않음).
 */
// story a539c649 S3a: projectId 는 이제 page.tsx(headers() 경유 resolve 결과)가 prop 으로
// 내려준다 — useDashboardContext()(전역 "현재 프로젝트")가 아니라 URL 이 가리키는 project.
export function ArtifactGalleryView({ projectId }: { projectId: string }) {
  const t = useTranslations('canvas');
  const tc = useTranslations('common');
  // story #3644(3632 후속) — handleCreateCommit 실패가 console.error만 남기고 사용자
  // 신호가 없었다(artifact-section.tsx와 동일 병).
  const { addToast } = useToast();
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
  /** story 083176e8(70a06b22 원안 재작) — 빈상태 CTA 귀속. 갤러리는 프로젝트 전역이라
   * story/epic/doc 앵커가 없어(BE에 생성 후 재배선 엔드포인트도 없음, 이전 그라운딩+PO 확定)
   * 생성 전 스토리를 먼저 골라야 한다. 피커에서 고른 storyId로 기존 ArtifactEditor 생성
   * 플로우(ArtifactSection.handleCreateCommit과 동일 패턴)를 그대로 재사용 —
   * createArtifact(storyId,...) 시그니처 무변경. */
  const [pickerOpen, setPickerOpen] = useState(false);
  // story #0692d5a7 — 「활성 여부」와 「귀속 스토리(nullable)」를 분리한다. 예전엔 creatingStoryId:
  // string|null 하나가 두 역할을 겸해(null=비활성) storyless 생성(null=활성인데 스토리 없음)을
  // 표현할 수 없었다. { storyId: string|null }|null 로 감싸 null=비활성·객체=활성(storyId는 그 안에서 nullable).
  const [creating, setCreating] = useState<{ storyId: string | null } | null>(null);
  /** story 64010b05 — 임포트도 갤러리에선 같은 스토리 피커를 경유해야 한다(귀속 필요, 083176e8과
   * 동일 이유). 피커는 공유하되 선택 후 어느 플로우로 갈지만 이 intent로 분기한다. */
  const [pickerIntent, setPickerIntent] = useState<'create' | 'import'>('create');
  const [importing, setImporting] = useState<{ storyId: string | null } | null>(null);

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

  /** story 083176e8 — ArtifactSection.handleCreateCommit과 동일 규율: 실패는 silent 금지(로깅+
   * 생성 모드 유지, 재시도 가능), 성공 시 갤러리 데이터를 다시 받아 새 산출물이 즉시 보이게 한다. */
  async function handleCreateCommit(storyId: string | null, nodes: Parameters<typeof createArtifact>[2], summary: string) {
    const detail = await createArtifact(storyId, t('untitledArtifact'), nodes, summary || undefined);
    if (!detail) {
      console.error('[canvas-gallery-create] artifact create commit failed', storyId);
      addToast({ title: t('artifactCreateFailed'), type: 'error' });
      return;
    }
    setCreating(null);
    if (!projectId) return;
    setLoading(true);
    const result = await fetchGalleryData(projectId);
    setArtifacts(result.artifacts);
    setLookups(result.lookups);
    setLoading(false);
  }

  /** story 64010b05 — handleCreateCommit과 동형이나 source='imported'만 다르다. */
  async function handleImportCommit(storyId: string | null, nodes: Parameters<typeof createArtifact>[2]): Promise<boolean> {
    const detail = await createArtifact(storyId, t('untitledArtifact'), nodes, undefined, 'imported');
    if (!detail) {
      console.error('[canvas-gallery-import] artifact import commit failed', storyId);
      return false;
    }
    setImporting(null);
    if (projectId) {
      setLoading(true);
      const result = await fetchGalleryData(projectId);
      setArtifacts(result.artifacts);
      setLookups(result.lookups);
      setLoading(false);
    }
    return true;
  }

  const axisLabel = (a: GalleryAxis) => t(`galleryAxis${a[0]!.toUpperCase()}${a.slice(1)}`);

  const createStart = () => { setPickerIntent('create'); setPickerOpen(true); };
  const importStart = () => { setPickerIntent('import'); setPickerOpen(true); };
  // 4910 — «그리기 · 가져오기»는 산출물이 하나라도 있을 때도 늘 머리에 선다(예전엔 빈 상태에만 — 하나라도 있으면 만들 길이 없던 것). 스토리 귀속 피커를 경유(083176e8 · 64010b05 규칙 그대로).
  const headActions = (
    <>
      <Button onClick={createStart}>{t('createCta')}</Button>
      <Button onClick={importStart}>{t('importCta')}</Button>
    </>
  );
  const head = (
    <PageHead
      description={t('gallerySubtitle')}
      meta={loading ? undefined : t('galleryCount', { count: artifacts.length })}
      actions={headActions}
    />
  );

  return (
    <PageFrame width="wide" data-testid="artifact-gallery">
      <TopBarSlot title={galleryTitle(t('galleryTitle'))} showContextChip />

      {creating ? (
        <ArtifactEditor
          title={t('untitledArtifact')}
          initialNodes={[]}
          onCommit={(committed, summary) => void handleCreateCommit(creating.storyId, committed, summary)}
          onDone={() => setCreating(null)}
        />
      ) : importing ? (
        <ImportArtifactDialog
          open
          onOpenChange={(next) => { if (!next) setImporting(null); }}
          onImport={(nodes) => handleImportCommit(importing.storyId, nodes)}
          targetId={importing.storyId}
        />
      ) : (
        <>
          {head}
          {loading ? (
            <GalleryGridSkeleton label={tc('loading')} />
          ) : artifacts.length === 0 ? (
            <div className={cn('rounded-ds-panel border border-ds-line', LAYER.panel)}>
              <EmptyState icon="image" title={t('galleryEmptyTitle')} description={t('emptyHint')} />
            </div>
          ) : (
            <section className={cn('rounded-ds-panel border border-ds-line', ARTIFACT_PANEL)} data-testid="artifact-gallery-panel">
              {/* 필터 한 줄 — «묶어서 보기»(축) + 그룹 고르기. 예전 왼쪽 200px 레일 · 좁은 화면 접이식(details)을 이 한 줄이 대신한다. */}
              <div className="flex flex-wrap items-center gap-2 border-b border-ds-line px-4 py-3" data-testid="artifact-gallery-filters">
                <span className="text-ds-small text-ds-ink-3">{t('galleryGroupBy')}</span>
                <div role="group" aria-label={t('galleryGroupBy')} className="flex flex-wrap items-center gap-1">
                  {GALLERY_AXES.map((a) => (
                    <Button
                      key={a}
                      aria-pressed={axis === a}
                      onClick={() => setAxis(a)}
                      className={cn(axis === a && 'border-ds-action bg-ds-action-soft text-ds-action-text hover:bg-ds-action-soft')}
                    >
                      {axisLabel(a)}
                    </Button>
                  ))}
                  <Button disabled aria-describedby="gallery-feature-axis-note">{t('galleryAxisFeature')}</Button>
                  <span id="gallery-feature-axis-note" className="sr-only">{t('galleryFeatureAxisUnsupported')}</span>
                </div>
                <label htmlFor="gallery-group-select" className="sr-only">{t('galleryGroupSelectLabel')}</label>
                <NativeSelect
                  id="gallery-group-select"
                  value={selectedGroupId ?? ''}
                  onChange={(e) => setSelectedGroupId(e.target.value)}
                  className="w-auto min-w-44 max-w-full"
                >
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>{g.label} ({g.artifacts.length})</option>
                  ))}
                </NativeSelect>
              </div>
              <div className="p-4">
                {!selectedGroup || selectedGroup.artifacts.length === 0 ? (
                  <p className="py-8 text-center text-ds-small text-ds-ink-3">{t('galleryGroupEmpty')}</p>
                ) : (
                  <div className={GALLERY_GRID}>
                    {selectedGroup.artifacts.map((artifact) => (
                      <ArtifactCard
                        key={artifact.id}
                        artifact={artifact}
                        axisT={t}
                        onOpen={() => void handleOpenArtifact(artifact.id, artifact.anchorVersion ?? artifact.latestVersionNumber, artifact.title)}
                      />
                    ))}
                  </div>
                )}
              </div>
            </section>
          )}
        </>
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
          artifactId={expandTarget.artifactId}
        />
      ) : null}
      {projectId ? (
        <StoryPickerDialog
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          projectId={projectId}
          allowSkip
          onSelect={(storyId) => {
            setPickerOpen(false);
            if (pickerIntent === 'import') setImporting({ storyId }); else setCreating({ storyId });
          }}
        />
      ) : null}
    </PageFrame>
  );
}
