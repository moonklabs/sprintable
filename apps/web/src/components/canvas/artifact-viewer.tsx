'use client';

import { useRef, useState } from 'react';
import { Check, Clock, Download, Import, Maximize2, MessageCircle, Pencil, Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';
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

interface ArtifactViewerProps {
  artifact: VisualArtifact;
  versions: ArtifactVersion[];
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
  onCreateThread?: (anchorXPercent: number, anchorYPercent: number, body: string) => void;
  /** C4-S8 정본화 — 승인은 새 UI 없이 기존 GateInbox가 처리(§1), 여기선 제안만. 선택된
   * 버전에 이미 대기 중인 제안이 있으면 pendingCanonicalizeVersion === selectedVersion. */
  pendingCanonicalizeVersion?: number | null;
  onProposeCanonical?: (versionNumber: number) => void;
  className?: string;
}

/**
 * E-CANVAS C1-S4 — Lv1 artifact 뷰어. 유나 핸드오프(`e-canvas-trust-surface-handoff` §3) 계약.
 * BE(`visual_artifact`/`artifact_version`, 디디 C1-S3) 미착지 — 이 컴포넌트는 props로 데이터를
 * 받는 순수 뷰라 실 API 착지 시 fetch 래퍼만 새로 감싸면 됨(컴포넌트 자체는 안 바뀜).
 */
export function ArtifactViewer({
  artifact, versions, memberMap = {}, threads, nodes = [], specPins, onEnterEdit, onResolveThread, onReplyThread,
  onCreateThread, pendingCanonicalizeVersion, onProposeCanonical, className,
}: ArtifactViewerProps) {
  const t = useTranslations('canvas');
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
  const activeVersion = versions.find((v) => v.version === selectedVersion) ?? versions[0];
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
  function handleComposeSubmit(body: string) {
    if (!draftPin) return;
    onCreateThread?.(draftPin.x, draftPin.y, body);
    setDraftPin(null);
  }
  function handleComposeCancel() {
    setDraftPin(null);
  }

  return (
    <div className={className}>
      {/* story #3009(로드맵 P2·PR-F, L1) — 인라인 카드는 --elev-card. */}
      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-[var(--elev-card)]">
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
          <span className="truncate text-sm font-semibold text-foreground">{artifact.title}</span>
          <span className="rounded-md border border-border bg-muted px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
            {artifact.format}
          </span>
          {/* story 64010b05 §5 — provenance는 신뢰(투명성) 축이지 감시 축이 아니다. 낙인/경고색
           * 0(muted 중립), created엔 라벨 자체가 없다(무표시=디폴트). */}
          {artifact.source === 'imported' ? (
            <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              <Import className="h-3 w-3" aria-hidden />
              {t('provenanceImportedBadge')}
            </span>
          ) : null}
          {/* story #2378(2026-08-01, 은퇴한 전신 `/mockups`와의 갭 기록) — 이 select는 과거
           * 버전을 «열람»만 한다. 전신 `/mockups`엔 `POST /{id}/versions`(옛 버전을 다시
           * 현재로 복원)가 있었는데 E-CANVAS엔 그 반대(rollback) 엔드포인트가 없다 — 열람과
           * 복원은 다른 기능이다. 실사용에서 필요해지면 별건으로 서야 한다(#2378 AC1 조사
           * 기록, 지금 새로 짓지 않는다 — 짓다 만 것이 아니라 «아직 안 지은 것»). */}
          <select
            value={selectedVersion}
            onChange={(e) => setSelectedVersion(Number(e.target.value))}
            className="rounded-md border border-border bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
          >
            {[...versions].sort((a, b) => b.version - a.version).map((v) => (
              <option key={v.id} value={v.version}>v{v.version}</option>
            ))}
          </select>
          {/* story d425dccc — 고정 넓이 html 전용 확대 뷰 진입점. v1의 축소-fit 토글은 방향
           * 오판으로 제거(스펙 ⓒ 판정) — 대신 큰 표면에서 실제 크기+pan으로 본다.
           * tree/image는 컨테이너에 맞춰 이미 렌더돼 대상이 아니다. */}
          {artifact.format === 'html' ? (
            <button
              type="button"
              onClick={() => setExpandOpen(true)}
              className="flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Maximize2 className="h-3 w-3" aria-hidden />
              {t('viewerExpandAction')}
            </button>
          ) : null}
          {artifact.anchor_version != null ? (
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-success/85">
              <Check className="h-3 w-3" strokeWidth={2.6} aria-hidden />
              {t('anchorBadge', { version: artifact.anchor_version })}
            </span>
          ) : null}
          {/* C4-S8 §1 — 에이전트/사람 모두 제안만, 승인은 GateInbox(인간 전용). 이미 정본이거나
           * 이미 대기 중인 제안이 있으면 제안 버튼을 숨긴다(중복 제안 방지). */}
          {!isViewingAnchor && onProposeCanonical ? (
            pendingCanonicalizeVersion === selectedVersion ? (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
                <Clock className="h-3 w-3" aria-hidden />
                {t('canonicalizePendingBadge')}
              </span>
            ) : (
              <button
                type="button"
                onClick={() => onProposeCanonical(selectedVersion)}
                className="flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[11px] font-semibold text-foreground hover:bg-muted"
              >
                <Sparkles className="h-3 w-3" aria-hidden />
                {t('proposeCanonicalAction')}
              </button>
            )
          ) : null}
          <span className="ml-auto flex items-center gap-3 text-muted-foreground">
            {artifact.format === 'tree' && onEnterEdit ? (
              <button
                type="button"
                onClick={onEnterEdit}
                className="flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] font-semibold text-foreground hover:bg-muted"
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
              className="flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
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
          <div className="relative min-w-0 bg-muted/20 p-4">
            {activeVersion ? (
              <div className="h-[320px] w-full">
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
                        <>
                          <AnchorPin
                            number={null}
                            state="draft"
                            className="absolute z-10"
                            style={{ left: `${draftPin.x}%`, top: `${draftPin.y}%` }}
                          />
                          <CommentComposePopover
                            onSubmit={handleComposeSubmit}
                            onCancel={handleComposeCancel}
                            style={{ left: `${draftPin.x}%`, top: `${draftPin.y}%` }}
                          />
                        </>
                      ) : null}
                    </>
                  }
                />
              </div>
            ) : null}
            {/* story #3377 — 인라인 스테이지는 pan/드래그 설계 보존을 위해 클릭을 안 받는다
             * (htmlInteractive 기본 false). html_blob이 실제로 상호작용(버튼 클릭 등)을
             * 요구하는 산출물일 수 있어, 그 경로가 「크게 보기」임을 명시한다. */}
            {artifact.format === 'html' ? (
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                {t('artifactStageInteractiveHint')}
              </p>
            ) : null}
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

        {threads && threads.length > 0 ? (
          <div className="space-y-2 border-t border-border bg-muted/10 p-3">
            {threads.map((th) => (
              <CommentThreadCard
                key={th.id}
                thread={th}
                memberMap={memberMap}
                active={th.id === selectedThreadId}
                onSelectPin={selectThread}
                onResolve={onResolveThread}
                onReply={onReplyThread}
              />
            ))}
          </div>
        ) : null}
        {/* story #2721(아티팩트·원장 1급화 1단) — 「이것을 가리키는 것들」. 신규 뷰어 0(기존
         * EntityBacklinksSection 재사용, doc/story와 동형) — 뷰어가 곧 상세 표면이라 여기 마운트
         * (ArtifactExpandDialog는 순수 캔버스 프리뷰라 대상 아님). */}
        <EntityBacklinksSection entityType="artifact" entityId={artifact.id} />
      </div>
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
    </div>
  );
}
