'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Clock, Download, Import, Maximize2, MessageCircle, Pencil, Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { ArtifactStage } from './artifact-stage';
import { ArtifactExpandDialog } from './artifact-expand-dialog';
import { ArtifactVersionRail } from './artifact-version-rail';
import { AnchorPin } from './anchor-pin';
import { SpecPinMarker } from './spec-pin-marker';
import { CommentThreadCard } from './comment-thread-card';
import { CommentComposePopover } from './comment-compose-popover';
import { DescriptionPane } from './description-pane';
import { ExportDialog } from './export-dialog';
import { EntityBacklinksSection } from '@/components/shared/entity-backlinks-section';
import type { ArtifactVersion, MemberRef, VisualArtifact } from '@/services/canvas';
import type { ArtifactNode } from '@/services/canvas-nodes';
import type { CommentThread } from '@/services/canvas-comments';
import type { SpecPin } from '@/services/canvas-spec-pins';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { Button as DsButton } from '@/components/ds/button';
import { Chip } from '@/components/ds/chip';
import { Icon } from '@/components/ds/icon';
import { NativeSelect } from '@/components/ds/select';
import { PageHead } from '@/components/ds/page-head';
import { LAYER } from '@/components/ds/layers';
import { ContextMenu, ContextMenuTrigger, MenuContent, MenuItem } from '@/components/ds/menu';

interface ArtifactViewerProps {
  artifact: VisualArtifact;
  /** story #4343 — 버전 목록 전부(`mergeVersionSummaries`). 실물이 아직 없는 항목(`contentLoaded: false`)은 고를 때 `loadVersion`으로 받는다. */
  versions: ArtifactVersion[];
  /** story #4343 — 이전 버전 실물 받기(`GET /{id}/versions/{n}`). 없으면 실물 없는 버전은 «불러오지 못했어요»로 둔다. */
  loadVersion?: (versionNumber: number) => Promise<ArtifactVersion | null>;
  memberMap?: Record<string, MemberRef>;
  /** C2 — 좌표 앵커 스레드는 스테이지에 핀 오버레이. element 앵커는 후속(실 artifact tree
   * 좌표 유도 필요 — 지금은 좌표 앵커만 오버레이). 헤더 아래 스레드 목록 패널도 이 prop으로
   * 렌더(있으면 element/coordinate 앵커 모두 카드로 나열 — 좌표 앵커만 핀 오버레이도 겸함). */
  threads?: CommentThread[];
  /** description pane 소스 — C2-S6 실 컬럼(node.description)을 element 앵커 코멘트가 가리키는
   * 노드에서 직접 조회(mock 시절 별도 DescriptionMap은 폐기 — 실 데이터 그대로 사용). */
  nodes?: ArtifactNode[];
  /** story 7fe16274 — 스펙 핀(좌표 앵커, doc `artifact-pin-authoring-spec` v1). BE는 항상
   * artifact의 latest version만 대상으로 하므로, 뷰어가 latest가 아닌 과거 버전을 보는
   * 중이면(버전 셀렉터로 이동) 핀을 그리지 않는다 — 다른 버전 레이아웃 위에 latest 스냅샷
   * 좌표를 얹으면 위치가 어긋난다(코드 정합성, no-fiction). */
  specPins?: SpecPin[];
  /** C3 §1 — 뷰어→편집모드 진입점. format='tree'일 때만 노출(html/image는 이 UI로 편집
   * 불가). 정본 버전을 보는 중이면 "새 버전으로 편집" 라벨(정본 계약 보호 — 실제 분기 로직은
   * BE 연동 시, 지금은 라벨만 다르고 동일 콜백). */
  onEnterEdit?: () => void;
  /** C2-S6 실 뮤테이션 — 생략하면 카드는 읽기전용(reply 입력/resolve 버튼이 no-op). */
  onResolveThread?: (threadId: string) => void;
  onReplyThread?: (threadId: string, body: string) => void;
  /** story #2725 — 새 좌표 스레드 생성(핀 추가 모드에서 캔버스 픽 → 작성). 생략하면 헤더
   * 배지가 토글 불가한 순수 카운트 표시로 폴백(onResolveThread/onReplyThread와 동일 옵션 규약). */
  /** 성공이면 true — 작성 칸 초안을 그때만 지운다(story #4370). */
  onCreateThread?: (anchorXPercent: number, anchorYPercent: number, body: string) => Promise<boolean>;
  /** C4-S8 정본화 — 승인은 새 UI 없이 기존 GateInbox가 처리(§1), 여기선 제안만. 선택된
   * 버전에 이미 대기 중인 제안이 있으면 pendingCanonicalizeVersion === selectedVersion. */
  pendingCanonicalizeVersion?: number | null;
  onProposeCanonical?: (versionNumber: number) => void;
  className?: string;
  /** 4910 — `embedded`(기본) = 스토리 패널 등 좁은 곳의 카드 한 장(예전 그대로) · `page` = 산출물 상세 화면의 한 쪽 틀(머리 + 보기 영역 + 오른쪽 열 하나, 칸이 좁으면 열이 아래로). */
  layout?: 'embedded' | 'page';
}

/**
 * E-CANVAS C1-S4 — Lv1 artifact 뷰어. 유나 핸드오프(`e-canvas-trust-surface-handoff` §3) 계약.
 * BE(`visual_artifact`/`artifact_version`, 디디 C1-S3) 미착지 — 이 컴포넌트는 props로 데이터를
 * 받는 순수 뷰라 실 API 착지 시 fetch 래퍼만 새로 감싸면 됨(컴포넌트 자체는 안 바뀜).
 */
export function ArtifactViewer({
  artifact, versions, loadVersion, memberMap = {}, threads, nodes = [], specPins, onEnterEdit, onResolveThread, onReplyThread,
  onCreateThread, pendingCanonicalizeVersion, onProposeCanonical, className, layout = 'embedded',
}: ArtifactViewerProps) {
  const t = useTranslations('canvas');
  const tc = useTranslations('common');
  const [selectedVersion, setSelectedVersion] = useState(artifact.current_version);
  const [expandOpen, setExpandOpen] = useState(false);
  const isViewingAnchor = selectedVersion === artifact.anchor_version;
  const isViewingLatest = selectedVersion === artifact.current_version;
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [selectedSpecPinId, setSelectedSpecPinId] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  // story #2725 — 핀 추가 모드(토글)+draft 핀(픽된 좌표, 아직 미저장). 픽 순간 모드는 꺼진다
  // (한 번에 하나만 작성 — 연속 픽 시 이전 draft가 조용히 버려지는 혼란 방지).
  const [pinAddMode, setPinAddMode] = useState(false);
  const [draftPin, setDraftPin] = useState<{ x: number; y: number } | null>(null);
  // story d72db00a — ArtifactStage의 콘텐츠 레이어에 직접 꽂힌다(contentRef prop 경유),
  // 뷰어 크롬 wrapper가 아니다 — PNG export가 크롬 없이 아트보드 전체 프레임만 캡처하도록.
  const captureTargetRef = useRef<HTMLDivElement>(null);
  // story #4373 — 쓰기 칸이 붙을 draft 핀.
  const draftPinRef = useRef<HTMLElement | null>(null);
  // story #4343 — 레일 · 고르개로 고른 이전 버전은 목록 요약뿐(`contentLoaded: false`)이라, 처음 고르는 순간 실물을 받아 둔다(한 번만).
  // 받는 중은 따로 적지 않는다(«실물이 필요한데 아직 없음»이 곧 받는 중) — 한 번만 부르게 부른 버전은 ref에 적는다.
  const [fetchedVersions, setFetchedVersions] = useState<Record<number, ArtifactVersion | 'failed'>>({});
  const requestedVersionsRef = useRef(new Set<number>());
  // 까디르 · 유나(4723) — «다시 시도»를 누르면 그 버튼이 사라지며(받는 중으로 바뀜) 키보드 초점이 body로 떨어졌다 → 스테이지 칸(받는 중 · 실물이
  // 번갈아 서는 늘 있는 자리 · tabIndex -1)으로 옮긴다. 실물이 서면 그 자리에 남고, **다시 실패하면 새 «다시 시도» 버튼으로** 돌려준다
  // (그사이 사용자가 초점을 다른 데로 옮겼으면 건드리지 않는다).
  const stageRegionRef = useRef<HTMLDivElement>(null);
  const retryButtonRef = useRef<HTMLButtonElement>(null);
  const retryFocusRef = useRef<number | null>(null);
  const loadVersionRef = useRef(loadVersion);
  useEffect(() => { loadVersionRef.current = loadVersion; });
  const listedVersion = versions.find((v) => v.version === selectedVersion) ?? versions[0];
  const fetched = listedVersion ? fetchedVersions[listedVersion.version] : undefined;
  const needsContent = listedVersion?.contentLoaded === false;
  useEffect(() => {
    if (!needsContent || !listedVersion || fetched) return;
    const n = listedVersion.version;
    const load = loadVersionRef.current;
    if (!load || requestedVersionsRef.current.has(n)) return;
    requestedVersionsRef.current.add(n);
    void load(n).then(
      (v) => setFetchedVersions((cur) => ({ ...cur, [n]: v ?? 'failed' })),
      () => setFetchedVersions((cur) => ({ ...cur, [n]: 'failed' })),
    );
  }, [needsContent, listedVersion, fetched]);
  const activeVersion = !needsContent ? listedVersion : typeof fetched === 'object' ? fetched : undefined;
  const versionLoadFailed = needsContent && (fetched === 'failed' || !loadVersion);
  useEffect(() => {
    const n = retryFocusRef.current;
    if (n === null || listedVersion?.version !== n) return;
    if (versionLoadFailed) {
      retryFocusRef.current = null;
      if (document.activeElement === stageRegionRef.current) retryButtonRef.current?.focus();
    } else if (activeVersion) {
      retryFocusRef.current = null; // 실물이 섰다 — 초점은 스테이지 칸에 그대로
    }
  }, [versionLoadFailed, activeVersion, listedVersion]);
  // 유나(4723) — 한 번 실패한 버전이 «부른 적 있음» 표시 때문에 다시 안 불려 늘 «못 했어요»였다 → 그 버전만 표시를 지우고 다시 부른다.
  const retryVersion = (n: number) => {
    retryFocusRef.current = n;
    stageRegionRef.current?.focus();
    requestedVersionsRef.current.delete(n);
    setFetchedVersions((cur) => {
      const next = { ...cur };
      delete next[n];
      return next;
    });
  };
  const selectedThread = threads?.find((th) => th.id === selectedThreadId) ?? null;
  const selectedThreadDescription = selectedThread?.anchor.element_id
    ? (nodes.find((n) => n.id === selectedThread.anchor.element_id)?.description ?? null)
    : null;
  const selectedSpecPin = specPins?.find((p) => p.id === selectedSpecPinId) ?? null;
  const openThreadCount = threads?.filter((th) => th.rollup !== 'resolved').length ?? 0;

  function selectThread(id: string) {
    setSelectedThreadId((cur) => (cur === id ? null : id));
    setSelectedSpecPinId(null);
  }
  function selectSpecPin(id: string) {
    setSelectedSpecPinId((cur) => (cur === id ? null : id));
    setSelectedThreadId(null);
  }

  function handlePickCoordinate(xPercent: number, yPercent: number) {
    setPinAddMode(false);
    setDraftPin({ x: xPercent, y: yPercent });
  }
  async function handleComposeSubmit(body: string): Promise<boolean> {
    if (!draftPin || !onCreateThread) return false;
    const pin = draftPin;
    setDraftPin(null);
    return onCreateThread(pin.x, pin.y, body);
  }
  function handleComposeCancel() {
    setDraftPin(null);
  }

  // 보기 영역 안 — «받는 중 · 못 받음 · 실물 스테이지 · html 안내». 끼움 위치(옛 카드 / 새 쪽)만 다르고 안은 한 벌.
  const stageH = layout === 'page' ? 'h-[min(70vh,720px)] min-h-[320px]' : 'h-[320px]';
  const stageBody = (
    <>
    {!activeVersion && needsContent ? (
      // story #4343 — 이전 버전 실물을 받는 중 · 못 받음(빈 캔버스로 «그 버전이 비었다»는 거짓을 그리지 않는다).
      <div data-version-loading={versionLoadFailed ? 'failed' : 'loading'} className={cn('flex w-full flex-col items-center justify-center gap-2 text-xs text-muted-foreground', stageH)}>
        <p role={versionLoadFailed ? 'alert' : 'status'}>{versionLoadFailed ? t('versionLoadFailed') : tc('loading')}</p>
        {versionLoadFailed && loadVersion && listedVersion ? (
          <Button ref={retryButtonRef} type="button" variant="outline" size="sm" onClick={() => retryVersion(listedVersion.version)}>
            {tc('retry')}
          </Button>
        ) : null}
      </div>
    ) : null}
    {activeVersion ? (
      <div className={cn('w-full', stageH)}>
        <ArtifactStage
          format={artifact.format}
          content={activeVersion.content}
          title={artifact.title}
          canvasBounds={activeVersion.canvasBounds}
          contentRef={captureTargetRef}
          pinAddMode={pinAddMode}
          onPickCoordinate={onCreateThread ? handlePickCoordinate : undefined}
          overlay={
            // C2 §1 — 좌표 앵커 스레드만 오버레이(element 앵커는 실 artifact tree 좌표 유도 필요, 후속).
            // story 1948d19d §2 — 이제 ArtifactStage의 캔버스 좌표계 안에서 pan/zoom을 그대로
            // 물려받는다(v2.1 상시 캡처 오버레이가 삼켰던 핀 클릭이 여기서 복원된다).
            <>
              {threads?.filter((th) => th.anchor.kind === 'coordinate').map((th) => (
                <AnchorPin
                  key={th.id}
                  number={th.pin_number}
                  state={th.rollup === 'resolved' ? 'resolved' : 'open'}
                  active={th.id === selectedThreadId}
                  onClick={() => selectThread(th.id)}
                  className="absolute z-10"
                  style={{ left: `${th.anchor.x}%`, top: `${th.anchor.y}%` }}
                />
              ))}
              {/* story 7fe16274 — 스펙 핀. latest 버전 볼 때만(BE가 항상 latest 대상이라
               * 과거 버전엔 어긋난 좌표가 됨, 위 prop 주석 참고). 좌표는 %(코멘트)가
               * 아니라 canvas_bounds px — 단위가 달라도 각자의 left/top는 서로 무간섭. */}
              {isViewingLatest ? specPins?.map((pin) => (
                <SpecPinMarker
                  key={pin.id}
                  active={pin.id === selectedSpecPinId}
                  onClick={() => selectSpecPin(pin.id)}
                  className="absolute z-10"
                  style={{ left: pin.anchorX ?? 0, top: pin.anchorY ?? 0 }}
                />
              )) : null}
              {/* story #2725 — draft 핀(저장 전) + compose 팝오버. isViewingLatest 무관하게
               * 항상 노출(핀 추가 자체가 항상 latest 버전 대상이라 selectedVersion과
               * 무관 — BE CREATE는 버전 개념 없이 artifact 스코프, spec pin과 다른 계약). */}
              {draftPin ? (
                <AnchorPin
                  ref={draftPinRef}
                  number={null}
                  state="draft"
                  className="absolute z-10"
                  style={{ left: `${draftPin.x}%`, top: `${draftPin.y}%` }}
                />
              ) : null}
            </>
          }
        />
        {/* story #4373 — 쓰기 칸은 무대(확대 변환 · 잘라내기 조상) 밖: body 포털 + fixed로 핀 사각형 아래(모자라면 위)에 붙고
          * 창 안으로 민다 · pan/zoom으로 핀이 움직이면 따라간다. 예전엔 변환 안에 그려 무대 10%면 22×10px로 작아졌고,
          * 무대 크기 층에 두면 좁은 곁 패널(무대 61px)에서 칸이 잘려 단추가 안 눌렸다. */}
        {draftPin ? (
          <CommentComposePopover
            onSubmit={handleComposeSubmit}
            onCancel={handleComposeCancel}
            draftTargetId={artifact.id}
            anchorRef={draftPinRef}
          />
        ) : null}
      </div>
    ) : null}
    {/* story #3377 — 인라인 스테이지는 pan/드래그 설계 보존을 위해 클릭을 안 받는다
     * (htmlInteractive 기본 false). html_blob이 실제로 상호작용(버튼 클릭 등)을
     * 요구하는 산출물일 수 있어, 그 경로가 「크게 보기」임을 명시한다. */}
    {artifact.format === 'html' ? (
      <p onContextMenu={(e) => e.stopPropagation()} className="mt-1.5 text-editorial-meta text-muted-foreground">
        {t('artifactStageInteractiveHint')}
      </p>
    ) : null}
    </>
  );
  const threadCards = threads && threads.length > 0 ? threads.map((th) => (
    <CommentThreadCard
      key={th.id}
      thread={th}
      memberMap={memberMap}
      active={th.id === selectedThreadId}
      onSelectPin={selectThread}
      onResolve={onResolveThread}
      onReply={onReplyThread}
    />
  )) : null;
  const embeddedThreads = threadCards ? (
    <div className="space-y-2 border-t border-border bg-muted/10 p-3">{threadCards}</div>
  ) : null;
  const dialogs = (
    <>
  <ExportDialog
    open={exportOpen}
    onOpenChange={setExportOpen}
    artifactId={artifact.id}
    versionNumber={selectedVersion}
    captureTargetRef={captureTargetRef}
    artifactFormat={artifact.format}
  />
  {activeVersion && artifact.format === 'html' ? (
    <ArtifactExpandDialog
      open={expandOpen}
      onOpenChange={setExpandOpen}
      title={artifact.title}
      format={artifact.format}
      content={activeVersion.content}
      canvasBounds={activeVersion.canvasBounds}
    />
  ) : null}
    </>
  );

  if (layout === 'page') {
    const sortedVersions = [...versions].sort((a, b) => b.version - a.version);
    const canPropose = !isViewingAnchor && !!onProposeCanonical;
    const proposePending = pendingCanonicalizeVersion === selectedVersion;
    // 4910 — 머리 단추와 그림 위 우클릭 메뉴가 «같은 동작 객체»를 쓴다(두 길이 어긋나지 않게 — AC4). 새 동작 0.
    const exportAction = { id: 'export', label: t('exportDialogTitle'), icon: 'download' as const, run: () => setExportOpen(true) };
    const proposeAction = canPropose && !proposePending ? { id: 'propose', label: t('proposeCanonicalAction'), icon: 'auto_awesome' as const, run: () => onProposeCanonical?.(selectedVersion) } : null;
    const pictureActions = [...(proposeAction ? [proposeAction] : []), exportAction];
    return (
      <div className={cn('flex flex-col gap-4', className)}>
        {/* 4910 — 제목은 위 막대 한 곳(화면 `artifact-detail-view`의 TopBarSlot). 머리 칸에는 칩(형식 · 임포트됨 · 정본) + 동작만 선다. */}
        <PageHead
          meta={
            <span className="inline-flex flex-wrap items-center gap-1.5 align-middle">
              <Chip mono>{artifact.format}</Chip>
              {artifact.source === 'imported' ? <Chip icon="upload">{t('provenanceImportedBadge')}</Chip> : null}
              {artifact.anchor_version != null ? <Chip tone="done" icon="check">{t('anchorBadge', { version: artifact.anchor_version })}</Chip> : null}
            </span>
          }
          actions={
            <>
              {/* 열람만(복원 아님 — story #2378 갭 기록 그대로). */}
              <NativeSelect
                aria-label={t('viewerVersionSelectLabel')}
                value={selectedVersion}
                onChange={(e) => setSelectedVersion(Number(e.target.value))}
                className="w-auto min-w-24"
              >
                {sortedVersions.map((v) => (
                  <option key={v.id} value={v.version}>v{v.version}</option>
                ))}
              </NativeSelect>
              {artifact.format === 'html' ? (
                <DsButton variant="quiet" iconStart={<Icon name="open_in_full" size={14} />} onClick={() => setExpandOpen(true)}>{t('viewerExpandAction')}</DsButton>
              ) : null}
              {canPropose && proposePending ? <Chip tone="needs-hand" icon="schedule">{t('canonicalizePendingBadge')}</Chip> : null}
              {proposeAction ? <DsButton iconStart={<Icon name={proposeAction.icon} size={14} />} onClick={proposeAction.run}>{proposeAction.label}</DsButton> : null}
              {artifact.format === 'tree' && onEnterEdit ? (
                <DsButton iconStart={<Icon name="edit" size={14} />} onClick={onEnterEdit}>{isViewingAnchor ? t('editAsNewVersionAction') : t('editAction')}</DsButton>
              ) : null}
              <DsButton iconStart={<Icon name={exportAction.icon} size={14} />} onClick={exportAction.run}>{exportAction.label}</DsButton>
              {onCreateThread ? (
                <DsButton
                  variant={pinAddMode ? 'primary' : 'quiet'}
                  aria-pressed={pinAddMode}
                  iconStart={<Icon name="chat_bubble" size={14} />}
                  onClick={() => setPinAddMode((v) => !v)}
                >
                  {t('addThreadToggleAction')}{openThreadCount > 0 ? ` · ${openThreadCount}` : ''}
                </DsButton>
              ) : null}
            </>
          }
        />
        <section data-testid="artifact-detail-panel" className={cn('@container overflow-hidden rounded-ds-panel border border-ds-line', LAYER.panel)}>
          {/* 칸 폭(컨테이너)이 넓으면 보기 영역 | 오른쪽 열 하나, 좁으면 열이 아래로 — 문서 읽기와 같은 컨테이너 쿼리. */}
          <div className="grid grid-cols-1 @min-[860px]:grid-cols-[minmax(0,1fr)_340px]">
            <div ref={stageRegionRef} tabIndex={-1} data-stage-region="" className={cn('relative min-w-0 p-4 outline-none', LAYER.well)}>
              {/* 4910 — 데스크톱 손길: 그림 위 우클릭 = 머리 단추와 같은 동작(정본으로 제안 · 내보내기). 우클릭에만 있는 동작 0 — 폰(터치)에는 머리 단추가 그대로. */}
              <ContextMenu>
                <ContextMenuTrigger data-testid="artifact-picture-menu-trigger" className="block">
                  {stageBody}
                </ContextMenuTrigger>
                <MenuContent>
                  {pictureActions.map((action) => (
                    <MenuItem key={action.id} icon={action.icon} onClick={action.run}>{action.label}</MenuItem>
                  ))}
                </MenuContent>
              </ContextMenu>
            </div>
            <aside data-testid="artifact-detail-column" className="flex min-w-0 flex-col divide-y divide-ds-line border-t border-ds-line @min-[860px]:border-t-0 @min-[860px]:border-l">
              <ArtifactVersionRail
                layout="column"
                artifact={artifact}
                versions={versions}
                selectedVersion={selectedVersion}
                onSelectVersion={setSelectedVersion}
                memberMap={memberMap}
                descriptionSlot={threads || specPins ? (
                  <DescriptionPane
                    description={selectedSpecPin ? selectedSpecPin.description : selectedThreadDescription}
                    elementLabel={selectedSpecPin ? undefined : selectedThread?.element_label}
                    className="mt-1.5"
                  />
                ) : undefined}
              />
              {threadCards ? (
                <section data-testid="artifact-detail-threads" aria-label={t('detailThreadsHeading')} className="space-y-3 p-4">
                  <h2 className="m-0 text-ds-small font-semibold text-ds-ink-2">{t('detailThreadsHeading')}</h2>
                  {threadCards}
                </section>
              ) : null}
              {/* 열 구분선(divide-y)이 이미 위 선을 그으니 자기 윗선은 끈다 — 겹선 둘 → 하나. */}
              <EntityBacklinksSection entityType="artifact" entityId={artifact.id} className="border-t-0" />
            </aside>
          </div>
        </section>
        {dialogs}
      </div>
    );
  }

  return (
    <div className={className}>
      {/* story #3009(로드맵 P2·PR-F, L1) — 인라인 카드는 --elev-card. */}
      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-[var(--elev-card)]">
        {/* [SID:4362] 좁은 폭(390/360 스토리 패널)에서 머리 한 줄에 다 안 들어가면 줄을 넘긴다(제목 줄 / 조작 줄). 예전엔 nowrap 한 줄이라
         * 조작 글자가 한 글자씩 세로로 쌓이고(한글은 글자마다 끊을 수 있어 최소 폭 = 한 글자) 제목은 0~8px로 눌렸다.
         * 제목 = 줄어들 수 있게(min-w-0 · 말줄임) · 조작 = 줄지 않고 안 꺾임(shrink-0 · whitespace-nowrap). 넓으면 예전과 같은 한 줄. */}
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2 border-b border-border px-4 py-3">
          <span className="min-w-0 max-w-full truncate text-sm font-semibold text-foreground">{artifact.title}</span>
          <span className="shrink-0 rounded-md border border-border bg-muted px-1.5 py-0.5 text-micro font-bold uppercase tracking-wide text-muted-foreground">
            {artifact.format}
          </span>
          {/* story 64010b05 §5 — provenance는 신뢰(투명성) 축이지 감시 축이 아니다. 낙인/경고색
           * 0(muted 중립), created엔 라벨 자체가 없다(무표시=디폴트). */}
          {artifact.source === 'imported' ? (
            <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-border bg-muted px-1.5 py-0.5 text-micro font-medium text-muted-foreground">
              <Import className="h-3 w-3" aria-hidden />
              {t('provenanceImportedBadge')}
            </span>
          ) : null}
          {/* story #2378(2026-08-01, 은퇴한 전신 `/mockups`와의 갭 기록) — 이 select는 과거
           * 버전을 «열람»만 한다. 전신 `/mockups`엔 `POST /{id}/versions`(옛 버전을 다시
           * 현재로 복원)가 있었는데 E-CANVAS엔 그 반대(rollback) 엔드포인트가 없다 — 열람과
           * 복원은 다른 기능이다. 실사용에서 필요해지면 별건으로 서야 한다(#2378 AC1 조사
           * 기록, 지금 새로 짓지 않는다 — 짓다 만 것이 아니라 «아직 안 지은 것»). */}
          <Select
            value={selectedVersion}
            onChange={(e) => setSelectedVersion(Number(e.target.value))}
            className="h-auto w-auto shrink-0 bg-muted px-1.5 py-0.5 text-muted-foreground lg:text-editorial-meta dark:bg-muted"
          >
            {[...versions].sort((a, b) => b.version - a.version).map((v) => (
              <option key={v.id} value={v.version}>v{v.version}</option>
            ))}
          </Select>
          {/* story d425dccc — 고정 넓이 html 전용 확대 뷰 진입점. v1의 축소-fit 토글은 방향
           * 오판으로 제거(스펙 ⓒ 판정) — 대신 큰 표면에서 실제 크기+pan으로 본다.
           * tree/image는 컨테이너에 맞춰 이미 렌더돼 대상이 아니다. */}
          {artifact.format === 'html' ? (
            <button
              type="button"
              onClick={() => setExpandOpen(true)}
              className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-border px-1.5 py-0.5 text-editorial-meta font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Maximize2 className="h-3 w-3" aria-hidden />
              {t('viewerExpandAction')}
            </button>
          ) : null}
          {artifact.anchor_version != null ? (
            <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-editorial-meta font-semibold text-success/85">
              <Check className="h-3 w-3" strokeWidth={2.6} aria-hidden />
              {t('anchorBadge', { version: artifact.anchor_version })}
            </span>
          ) : null}
          {/* C4-S8 §1 — 에이전트/사람 모두 제안만, 승인은 GateInbox(인간 전용). 이미 정본이거나
           * 이미 대기 중인 제안이 있으면 제안 버튼을 숨긴다(중복 제안 방지). */}
          {!isViewingAnchor && onProposeCanonical ? (
            pendingCanonicalizeVersion === selectedVersion ? (
              <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-editorial-meta font-medium text-muted-foreground">
                <Clock className="h-3 w-3" aria-hidden />
                {t('canonicalizePendingBadge')}
              </span>
            ) : (
              <button
                type="button"
                onClick={() => onProposeCanonical(selectedVersion)}
                className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-border px-1.5 py-0.5 text-editorial-meta font-semibold text-foreground hover:bg-muted"
              >
                <Sparkles className="h-3 w-3" aria-hidden />
                {t('proposeCanonicalAction')}
              </button>
            )
          ) : null}
          <span className="ml-auto flex shrink-0 items-center gap-3 whitespace-nowrap text-muted-foreground">
            {artifact.format === 'tree' && onEnterEdit ? (
              <button
                type="button"
                onClick={onEnterEdit}
                className="flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-editorial-meta font-semibold text-foreground hover:bg-muted"
              >
                <Pencil className="h-3 w-3" aria-hidden />
                {isViewingAnchor ? t('editAsNewVersionAction') : t('editAction')}
              </button>
            ) : null}
            {/* story #3378(결함·customer-zero, 선생님 실사용) — 아이콘 단독이라 못 찾았다는
             * 지적. title(호버 툴팁)만으론 발견성이 부족해 라벨 텍스트를 상시 노출한다. */}
            <button
              type="button"
              onClick={() => setExportOpen(true)}
              title={t('exportDialogTitle')}
              className="flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-editorial-meta font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Download className="h-3.5 w-3.5" aria-hidden />
              {t('exportDialogTitle')}
            </button>
            {/* story #2725 — commentsComingSoon 자리표시자 폐기(미착지 트랙이 착지). onCreateThread
             * 없으면(호출부 미배선) 토글 불가한 순수 카운트 표시로 폴백 — onResolveThread/onReplyThread와
             * 동일한 "옵션 생략=읽기전용" 규약. */}
            {onCreateThread ? (
              <button
                type="button"
                onClick={() => setPinAddMode((v) => !v)}
                aria-pressed={pinAddMode}
                title={t('addThreadToggleAction')}
                className={`flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs ${pinAddMode ? 'bg-primary/10 text-primary' : 'hover:text-foreground'}`}
              >
                <MessageCircle className="h-3.5 w-3.5" aria-hidden />
                {openThreadCount > 0 ? openThreadCount : null}
              </button>
            ) : (
              <span className="flex items-center gap-1 text-xs">
                <MessageCircle className="h-3.5 w-3.5" aria-hidden />
                {openThreadCount > 0 ? openThreadCount : null}
              </span>
            )}
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_232px]">
          <div ref={stageRegionRef} tabIndex={-1} data-stage-region="" className="relative min-w-0 bg-muted/20 p-4 outline-none">
            {stageBody}
          </div>
          <ArtifactVersionRail
            artifact={artifact}
            versions={versions}
            selectedVersion={selectedVersion}
            onSelectVersion={setSelectedVersion}
            memberMap={memberMap}
            descriptionSlot={threads || specPins ? (
              <DescriptionPane
                description={selectedSpecPin ? selectedSpecPin.description : selectedThreadDescription}
                elementLabel={selectedSpecPin ? undefined : selectedThread?.element_label}
                className="mt-1.5"
              />
            ) : undefined}
          />
        </div>

        {embeddedThreads}
        {/* story #2721(아티팩트·원장 1급화 1단) — 「이것을 가리키는 것들」. 신규 뷰어 0(기존
         * EntityBacklinksSection 재사용, doc/story와 동형) — 뷰어가 곧 상세 표면이라 여기 마운트
         * (ArtifactExpandDialog는 순수 캔버스 프리뷰라 대상 아님). */}
        <EntityBacklinksSection entityType="artifact" entityId={artifact.id} />
      </div>
      {dialogs}
    </div>
  );
}
