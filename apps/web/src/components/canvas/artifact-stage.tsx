'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Maximize2, Scan } from 'lucide-react';
import type { ArtifactFormat } from '@/services/canvas';

/**
 * story 1948d19d — 캔버스 뷰포트 전면 재설계. 설계 SSOT: doc `artifact-canvas-viewport-spec`.
 * v1(385eb89a·스크롤+overflow) → v2(d425dccc·space+드래그 pan) → v2.1(e4cce704·상시 오버레이
 * 직접드래그) 세 번의 "증상 단위" 패치가 전부 틀린 모델(스크롤 문서 창) 안에서 반복됐던 게
 * 근본 문제 — 산출물은 스크롤 문서가 아니라 **캔버스 위 오브젝트**(Figma 캔버스 뷰포트 레퍼런스).
 *
 * 이 재작성으로 v1~v2.1의 overflow·스크롤바·space 잔재가 전부 소멸한다:
 * - 뷰포트 = `transform: translate(tx,ty) scale(s)` 하나 — pan은 전방향(가로/세로 구분 없음)·
 *   "잘림" 상태 자체가 없다(콘텐츠는 항상 캔버스 위 어딘가에 있고, 안 보이면 이동하면 그만).
 * - 휠=pan·⌘/Ctrl+휠(트랙패드 핀치와 동일 신호)=커서 중심 줌.
 * - **crux(v2.1 오류 교정)**: 상시 전면 캡처 오버레이를 폐기 — iframe/img/tree 콘텐츠는 항상
 *   `pointer-events:none`(렌더된 오브젝트일 뿐, 상호작용 대상이 아님). 핀 등 우리 DOM 오버레이만
 *   `pointer-events:auto`로 상호작용 가능 — 이동-임계값(4px) 초과 드래그 중엔 오버레이도
 *   pointer-events:none으로 전환해 "핀 위에서 시작한 드래그가 pan으로 해석"을 순수 CSS로
 *   구현한다(핀 자체의 onClick은 무변경 — 임계 미달=일반 클릭이 그대로 발화).
 *
 * story 74d6047e — 모바일 터치(2-finger 핀치 줌·더블탭 fit/100% 토글) 추가. 1-finger는 이미
 * 제네릭 Pointer Events pan 경로가 그대로 작동해 신규 로직 불필요(선생님 실사용 지적으로
 * 발견된 갭은 핀치뿐). `touch-none`(touch-action:none)은 그대로 유지 — 우리 transform이
 * 유일 소비자라 브라우저 네이티브 핀치줌/스크롤로의 위임이 애초에 없다(휠 배타성 #2138과
 * 동일 원칙이지만, wheel의 React onWheel passive 문제와 달리 touch-action:none은 CSS
 * 네이티브 옵트아웃이라 preventDefault 트릭이 따로 필요 없다).
 */

// 문서형 기본 아트보드 — canvas_bounds 미선언 폴백(§4, 가짜 추정 아님·명시된 규약). export —
// story 7fe16274(핀 저작)이 클릭 좌표→canvas_bounds 좌표계 환산에 동일 값을 참조해야
// 배치 시점(edit)과 렌더 시점(view)의 좌표계가 어긋나지 않는다(값 중복선언 금지).
export const DEFAULT_BOUNDS = { w: 1280, h: 800 };
const MIN_SCALE = 0.1;
const MAX_SCALE = 4;
const DRAG_THRESHOLD_PX = 4;
const PAN_MARGIN_PX = 120; // soft bound — 콘텐츠가 이 여백 밖으로 완전히 사라지진 않게
const WHEEL_ZOOM_SENSITIVITY = 0.0015;
const DOUBLE_TAP_MS = 300; // story 74d6047e §4 — 더블탭 판정 시간 창(지도/사진 앱 관례)
const DOUBLE_TAP_PX = 40; // 손가락은 마우스만큼 정밀하지 않아 클릭보다 넓은 허용 반경

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}

/**
 * E-CANVAS C1 — tree 포맷 최소 노드 shape. BE 계약(디디 C1-S3) 착지 전 잠정 — 실 계약이
 * flat adjacency-list(전신 `/mockups` 패턴)로 오면 이 shape로 변환하는 어댑터만 추가하면 됨
 * (렌더 로직 자체는 안 건드림).
 */
export interface ArtifactTreeNode {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  children?: ArtifactTreeNode[];
}

// story 3d0d60a3 — 반응형 미리보기 브레이크포인트 프리셋. 데스크톱은 canvas_bounds.w 그대로라
// 별도 프리셋이 없다(override 부재=데스크톱).
export const RESPONSIVE_PREVIEW_BREAKPOINTS = { mobile: 375, tablet: 768 } as const;
export type ResponsivePreviewBreakpoint = keyof typeof RESPONSIVE_PREVIEW_BREAKPOINTS;

/**
 * story 3d0d60a3 — 반응형 판정(유나 1순위: 소스 @media 파싱). html_blob은 iframe에 srcDoc으로
 * 주입되기 전 우리 손 안의 문자열이라 cross-origin과 무관하게 값싸게 검사 가능(신규 BE 0).
 * `@media` 뒤에 `{`가 오는지까지 확인해 "@media"라는 글자가 우연히 텍스트/주석에 등장하는
 * false-positive를 줄인다. @media 없는 유동(flex/grid %) 레이아웃은 false-negative로 보수적
 * 미노출 — PO/유나 확定(no-fiction: 과대 판정보다 과소 판정이 안전).
 */
export function isResponsiveHtml(content: string): boolean {
  return /@media[^{}]*\{/i.test(content);
}

/** content 문자열을 tree 노드 배열로 안전 파싱 — 형태가 아니면 null(크래시 대신 폴백 렌더). */
export function parseArtifactTree(content: string): ArtifactTreeNode[] | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!Array.isArray(parsed)) return null;
    if (!parsed.every((n) => typeof n === 'object' && n !== null && 'id' in n && 'type' in n)) return null;
    return parsed as ArtifactTreeNode[];
  } catch {
    return null;
  }
}

function TreeNodeBox({ node }: { node: ArtifactTreeNode }) {
  const text = typeof node.props?.['text'] === 'string' ? (node.props['text'] as string) : node.type;
  return (
    <div className="rounded-md border border-border bg-card p-2 text-xs text-foreground">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{node.type}</span>
      {text ? <p className="mt-0.5 truncate">{text}</p> : null}
      {node.children && node.children.length > 0 ? (
        <div className="mt-1.5 space-y-1.5 border-l border-border pl-2">
          {node.children.map((c) => <TreeNodeBox key={c.id} node={c} />)}
        </div>
      ) : null}
    </div>
  );
}

interface ArtifactStageProps {
  format: ArtifactFormat;
  content: string;
  title: string;
  /** story 1948d19d §4(BE #2135) — 선언된 아트보드 크기(그 버전의 불변 스냅샷). null/undefined
   * (레거시·미선언·#2135 착지 전)면 포맷별 기본 아트보드로 폴백(가짜 추정 0 — 측정이 아니라
   * 선언된 규약). image 포맷은 이 값과 무관하게 로드 후 실측 자연 크기를 우선한다. */
  canvasBounds?: { w: number; h: number } | null;
  /** story 1948d19d §2 — 캔버스 좌표계(bounds 기준 %) 오버레이(핀·앵커·마커 등 우리 DOM).
   * 뷰포트 transform을 그대로 물려받아 pan/zoom에 동반 이동한다. 드래그 확定 중엔 이 레이어
   * 전체가 pointer-events:none으로 전환돼 핀 위에서 시작한 드래그가 pan으로만 해석된다
   * (핀 자신의 onClick은 무변경 — 임계 미달 클릭만 정상 발화). */
  overlay?: React.ReactNode;
  /** story 1948d19d §3(PR B) — 'edit'이면 콘텐츠 레이어(TreeStageContent)를 렌더하지 않는다.
   * tree는 cross-origin 콘텐츠가 없는 우리 DOM이라 편집 UI(선택 가능한 노드)를 그대로
   * `overlay`로 넘기면 되고, 그럼 content 레이어에 비활성 트리를 중복 렌더할 이유가 없다
   * (핀과 동일한 pointer-events 토글 메커니즘을 재사용 — 새 로직 불필요). 기본 'view'. */
  mode?: 'view' | 'edit';
  /** story d72db00a — PNG export 캡처 대상을 콘텐츠 레이어(`data-artifact-canvas-content`)
   * 자체에 직접 꽂기 위한 ref. 뷰어 크롬(힌트·줌%·fit/100% 버튼)은 이 div의 형제 요소라
   * 이 ref로 캡처하면 자동으로 제외된다 — canvas_bounds 고정 width/height라 pan/zoom
   * transform만 캡처 직전 순간 정규화하면(canvas-export.ts) 아트보드 전체 프레임이 나온다. */
  contentRef?: React.RefObject<HTMLDivElement | null>;
  /** story 3d0d60a3 — 반응형 미리보기 브레이크포인트 폭 override(html 포맷 전용, 뷰어 모달
   * 브레이크포인트 셀렉터에서만 넘어온다). 넘어오면 `bounds.w`를 이 값으로 교체해 pan/zoom
   * 엔진(fit/clampPan) 전부가 그대로 이 폭 기준으로 재계산되고, 콘텐츠 레이어와 iframe 자기
   * 자신의 width가 함께 바뀌어 실제 리플로우가 일어난다(래퍼 폭만 바꾸던 구 토글의 실패
   * 원인 회피 — 그라운딩 결론 그대로). 높이는 canvas_bounds.h 유지(iframe이 sandbox=""라
   * 리플로우 후 실제 콘텐츠 높이를 부모가 측정할 방법이 없음 — cross-origin 격리, 정직 단순화).
   * 저작 시점 canvasBounds 자체는 건드리지 않는다(핀 좌표·썸네일 등 다른 소비처와 무관).
   */
  previewWidth?: number;
}

/**
 * story 1948d19d — transform 캔버스 뷰포트 엔진. 3포맷(html/image/tree) 공유 — "전 표면 통일"의
 * 핵심은 이 하나의 pan/zoom/선택 계약이지 포맷별 렌더 방식이 아니다(포맷은 콘텐츠 레이어
 * 안쪽만 다름). sandbox 무완화 유지(iframe은 여전히 `sandbox=""`) — pointer-events:none이라
 * 상호작용 레이어와 물리적으로 분리되므로 완화할 필요 자체가 없다.
 */
function CanvasViewport({ format, content, title, canvasBounds, overlay, mode = 'view', contentRef, previewWidth }: {
  format: ArtifactFormat; content: string; title: string;
  canvasBounds?: { w: number; h: number } | null; overlay?: React.ReactNode; mode?: 'view' | 'edit';
  contentRef?: React.RefObject<HTMLDivElement | null>;
  previewWidth?: number;
}) {
  const t = useTranslations('canvas');
  // story 70a06b22 — 어제(74d6047e) 만든 터치 핀치/더블탭이 힌트 카피에 반영 안 된 발견성 갭
  // 봉합. `(pointer: coarse)` 1회 판정(라이브 세션 중 입력 수단이 바뀌는 하이브리드 기기는
  // 희귀 엣지케이스라 리스너로 추적하지 않음 — SSR 안전을 위해 lazy initializer로 분기,
  // effect 안 동기 setState 지양(기존 IntersectionObserver 가드와 동형 패턴).
  const [isTouchDevice] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewportSize, setViewportSize] = useState({ w: 0, h: 0 });
  const [transform, setTransform] = useState({ tx: 0, ty: 0, scale: 1 });
  const [isDragging, setIsDragging] = useState(false);
  const [imageBounds, setImageBounds] = useState<{ w: number; h: number } | null>(null);
  const dragRef = useRef({ startX: 0, startY: 0, startTx: 0, startTy: 0, movedPast: false, pointerId: -1 });
  const firedFitRef = useRef(false);
  // story 74d6047e — 2-finger 핀치 줌. 활성 터치 포인터 위치 추적 + 핀치 baseline(포인터 수가
  // 바뀔 때마다 재캡처 — crux: delta는 항상 "이 순간"의 baseline 대비라 점프가 없다).
  const touchPointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchBaselineRef = useRef<{ distance: number; midX: number; midY: number; scale: number; tx: number; ty: number } | null>(null);
  const lastTapRef = useRef<{ time: number; x: number; y: number } | null>(null);

  // image=실측 우선(로드 후 자연 크기가 선언보다 정확) → 그 다음 선언된 canvas_bounds(§4,
  // BE #2135) → 마지막 포맷별 기본 아트보드(가짜 추정 아님·명시된 폴백 규약).
  const authoredBounds = format === 'image' && imageBounds ? imageBounds : (canvasBounds ?? DEFAULT_BOUNDS);
  // story 3d0d60a3 — previewWidth가 있으면 폭만 교체(높이는 저작 아트보드 그대로) — fit/pan/
  // iframe 렌더 전부 이 하나의 bounds를 참조하므로 재계산 로직 추가 없이 재렌더가 성립한다.
  const bounds = previewWidth != null ? { w: previewWidth, h: authoredBounds.h } : authoredBounds;

  useEffect(() => { setImageBounds(null); firedFitRef.current = false; }, [content]);

  // ResizeObserver 미지원 환경(구형 브라우저·이 프로젝트 vitest jsdom) — 정적 폴백, 크래시 방지.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const measure = () => setViewportSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const clampPan = useCallback((tx: number, ty: number, scale: number, vw: number, vh: number) => {
    const contentW = bounds.w * scale;
    const contentH = bounds.h * scale;
    const minTx = vw - contentW - PAN_MARGIN_PX;
    const maxTx = PAN_MARGIN_PX;
    const minTy = vh - contentH - PAN_MARGIN_PX;
    const maxTy = PAN_MARGIN_PX;
    return {
      tx: minTx <= maxTx ? clamp(tx, minTx, maxTx) : (vw - contentW) / 2,
      ty: minTy <= maxTy ? clamp(ty, minTy, maxTy) : (vh - contentH) / 2,
    };
  }, [bounds.w, bounds.h]);

  const fitToView = useCallback(() => {
    const { w: vw, h: vh } = viewportSize;
    if (vw === 0 || vh === 0) return;
    const scale = clamp(Math.min(vw / bounds.w, vh / bounds.h), MIN_SCALE, MAX_SCALE);
    const tx = (vw - bounds.w * scale) / 2;
    const ty = (vh - bounds.h * scale) / 2;
    setTransform({ tx, ty, scale });
  }, [viewportSize, bounds.w, bounds.h]);

  const actualSize = useCallback(() => {
    const { w: vw, h: vh } = viewportSize;
    const tx = (vw - bounds.w) / 2;
    const ty = (vh - bounds.h) / 2;
    setTransform({ tx, ty, scale: 1 });
  }, [viewportSize, bounds.w, bounds.h]);

  // story 74d6047e §4 — 더블탭=fit↔100% 토글(탭 지점 중심, 지도/사진 앱 관례). ⌘/Ctrl+휠 커서중심
  // 줌과 동일한 수학(고정 화면점 아래 콘텐츠점을 유지) — 목표 scale만 연속값 대신 두 값 중 토글.
  const toggleZoomAtPoint = useCallback((screenX: number, screenY: number) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    const localX = screenX - rect.left;
    const localY = screenY - rect.top;
    const fitScale = clamp(Math.min(viewportSize.w / bounds.w, viewportSize.h / bounds.h), MIN_SCALE, MAX_SCALE);
    setTransform((cur) => {
      const nextScale = Math.abs(cur.scale - 1) < 0.02 ? fitScale : 1;
      const contentX = (localX - cur.tx) / cur.scale;
      const contentY = (localY - cur.ty) / cur.scale;
      const next = clampPan(localX - contentX * nextScale, localY - contentY * nextScale, nextScale, viewportSize.w, viewportSize.h);
      return { ...next, scale: nextScale };
    });
  }, [viewportSize, bounds.w, bounds.h, clampPan]);

  // 최초 진입 = fit(콘텐츠 전체가 즉시 보이는 것이 재설계의 근본 목적 — "잘림 상태 부존재").
  useEffect(() => {
    if (firedFitRef.current) return;
    if (viewportSize.w === 0 || viewportSize.h === 0) return;
    firedFitRef.current = true;
    fitToView();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 최초 1회만(콘텐츠/뷰포트 변경 시 재-fit 강제 안 함, 사용자가 이미 조작했을 수 있음)
  }, [viewportSize.w, viewportSize.h]);

  function handlePointerDown(e: React.PointerEvent) {
    // story 74d6047e — 1-finger는 이미 pointer 이벤트 제네릭 pan 경로가 그대로 작동한다(터치
    // 전용 신규 로직 불필요, 아래 공유 코드로 진행). 2-finger째만 핀치로 분기.
    if (e.pointerType === 'touch') {
      touchPointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touchPointersRef.current.size === 2) {
        const el = e.currentTarget as HTMLElement;
        if (typeof el.setPointerCapture === 'function') el.setPointerCapture(e.pointerId);
        // crux — 포인터 수 1→2 전이 시 baseline 재캡처(delta는 항상 이 순간 기준) — 점프 방지.
        // midpoint는 viewport-local로 변환(transform.tx/ty와 같은 좌표계라야 아래 공식이 맞다 —
        // touchPointersRef 자체는 dragRef와 동형으로 raw client 유지, 여기서만 rect 보정).
        const rect = el.getBoundingClientRect();
        const [p1, p2] = [...touchPointersRef.current.values()];
        pinchBaselineRef.current = {
          distance: Math.hypot(p2.x - p1.x, p2.y - p1.y),
          midX: (p1.x + p2.x) / 2 - rect.left, midY: (p1.y + p2.y) / 2 - rect.top,
          scale: transform.scale, tx: transform.tx, ty: transform.ty,
        };
        dragRef.current.pointerId = -1; // 1-터치 pan 경로 무력화 — 핀치와 동시 구동 방지
        return;
      }
    }
    if (e.button !== 0) return;
    dragRef.current = { startX: e.clientX, startY: e.clientY, startTx: transform.tx, startTy: transform.ty, movedPast: false, pointerId: e.pointerId };
    const el = e.currentTarget as HTMLElement;
    // 구형 브라우저·이 프로젝트 vitest jsdom 둘 다 미지원 가능 — pan 자체는 capture 없이도
    // 동작(빠른 드래그가 요소 밖으로 나가면 move를 놓칠 수 있는 정도의 성능 저하일 뿐).
    if (typeof el.setPointerCapture === 'function') el.setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (e.pointerType === 'touch' && touchPointersRef.current.has(e.pointerId)) {
      touchPointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touchPointersRef.current.size === 2 && pinchBaselineRef.current) {
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const [p1, p2] = [...touchPointersRef.current.values()];
        const baseline = pinchBaselineRef.current;
        const newDistance = Math.hypot(p2.x - p1.x, p2.y - p1.y); // rect-invariant(차분이라 보정 불필요)
        const newMidX = (p1.x + p2.x) / 2 - rect.left; // baseline과 동일 좌표계(viewport-local)로 변환
        const newMidY = (p1.y + p2.y) / 2 - rect.top;
        // 거리비=scale(baseline 대비) — 클램프는 데스크톱과 동일 10~400%.
        const nextScale = clamp(baseline.scale * (newDistance / baseline.distance), MIN_SCALE, MAX_SCALE);
        // baseline midpoint 아래 있던 콘텐츠 점을 구해, 그 점이 "지금" midpoint(이동했을 수 있음)
        // 아래 있도록 재배치 — 줌(거리비)과 pan(midpoint 이동)이 한 수식으로 동시에 풀린다.
        const contentX = (baseline.midX - baseline.tx) / baseline.scale;
        const contentY = (baseline.midY - baseline.ty) / baseline.scale;
        const next = clampPan(newMidX - contentX * nextScale, newMidY - contentY * nextScale, nextScale, viewportSize.w, viewportSize.h);
        setIsDragging(true); // 핀치 중엔 오버레이(핀 등) pointer-events:none — 기존 드래그 규약 재사용
        setTransform({ ...next, scale: nextScale });
        return;
      }
      // 1터치째는 여기서 return하지 않고 아래 공유 pan 로직으로 그대로 진행(신규 로직 0).
    }
    const d = dragRef.current;
    if (d.pointerId !== e.pointerId) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.movedPast && Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
      d.movedPast = true;
      setIsDragging(true);
    }
    if (d.movedPast) {
      const next = clampPan(d.startTx + dx, d.startTy + dy, transform.scale, viewportSize.w, viewportSize.h);
      setTransform((cur) => ({ ...cur, ...next }));
    }
  }

  function handlePointerUp(e: React.PointerEvent) {
    if (e.pointerType === 'touch') {
      const wasPinching = touchPointersRef.current.size === 2;
      const liftedPos = touchPointersRef.current.get(e.pointerId);
      touchPointersRef.current.delete(e.pointerId);
      const el = e.currentTarget as HTMLElement;
      if (typeof el.releasePointerCapture === 'function') el.releasePointerCapture(e.pointerId);
      const remaining = [...touchPointersRef.current.entries()];

      if (wasPinching && remaining.length === 1) {
        // crux — 2→1 전이 시 남은 손가락 기준 pan baseline 재캡처(delta 0부터) — 점프 방지.
        const [remainingId, remainingPos] = remaining[0]!;
        dragRef.current = {
          startX: remainingPos.x, startY: remainingPos.y, startTx: transform.tx, startTy: transform.ty,
          movedPast: true, pointerId: remainingId,
        };
        pinchBaselineRef.current = null;
        return;
      }
      if (remaining.length === 0) {
        pinchBaselineRef.current = null;
        // 더블탭 판정 — 핀치의 일부였던 리프트(wasPinching)는 탭이 아니다. 순수 탭(이동<임계값)만.
        const d = dragRef.current;
        const wasTap = !wasPinching && d.pointerId === e.pointerId && !d.movedPast;
        if (wasTap && liftedPos) {
          const now = performance.now();
          const last = lastTapRef.current;
          const isDoubleTap = !!last && now - last.time < DOUBLE_TAP_MS
            && Math.hypot(liftedPos.x - last.x, liftedPos.y - last.y) < DOUBLE_TAP_PX;
          if (isDoubleTap) {
            lastTapRef.current = null;
            toggleZoomAtPoint(liftedPos.x, liftedPos.y);
          } else {
            lastTapRef.current = { time: now, x: liftedPos.x, y: liftedPos.y };
          }
        }
        dragRef.current.pointerId = -1;
        setIsDragging(false);
      }
      return;
    }
    const d = dragRef.current;
    if (d.pointerId !== e.pointerId) return;
    const el = e.currentTarget as HTMLElement;
    if (typeof el.releasePointerCapture === 'function') el.releasePointerCapture(e.pointerId);
    dragRef.current.pointerId = -1;
    setIsDragging(false);
  }

  // crux(선생님 실사용 즉시지적) — React onWheel은 루트에 passive 위임으로 붙어 e.preventDefault()가
  // 조용히 무효화된다(React 17+ 표준 동작). 그 결과 우리 pan/줌이 실행되는 **동시에** 브라우저
  // 네이티브 스크롤(휠)과 네이티브 Ctrl+휠 페이지 줌이 함께 새어나갔다("휠=pan 배타 소비" 계약
  // 위반). 해법은 표준적으로 known: ref에 네이티브 `addEventListener('wheel', h, {passive:false})`를
  // 직접 붙여야 preventDefault()가 실제로 먹는다 — React 합성 이벤트 prop으로는 안 됨.
  const handleWheelRef = useRef<(e: WheelEvent) => void>(() => {});

  function handleWheel(e: WheelEvent) {
    if (!(e.ctrlKey || e.metaKey)) {
      // story 1948d19d §3(PR#2137 까심 QA 비차단 발견, 이 fix로 preventDefault가 실제로 먹기
      // 시작하면서 노출됨) — 편집 캔버스의 긴 노드트리(overflow-auto)는 자체 내부 스크롤이
      // 있다. plain wheel(=pan 의도)이 실제로 넘칠 내용이 있는 스크롤 가능 영역 위에서
      // 시작됐으면 캔버스 pan 대신 네이티브 내부 스크롤에 양보한다(우리가 소비 안 함).
      // ctrl/meta+wheel(=줌 의도)은 무조건 우리가 소비 — 그래야 네이티브 페이지 줌 누출
      // 방지(이 PR의 crux)가 전 영역에서 안 깨진다.
      const scrollable = (e.target as HTMLElement | null)?.closest?.('[data-canvas-scrollable]') as HTMLElement | null;
      if (scrollable && scrollable.scrollHeight > scrollable.clientHeight) return;
    }
    e.preventDefault();
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    if (e.ctrlKey || e.metaKey) {
      // ⌘/Ctrl+휠 · 트랙패드 핀치(브라우저가 ctrlKey=true wheel로 합성) — 커서 중심 줌.
      const localX = e.clientX - rect.left;
      const localY = e.clientY - rect.top;
      setTransform((cur) => {
        const nextScale = clamp(cur.scale * (1 - e.deltaY * WHEEL_ZOOM_SENSITIVITY), MIN_SCALE, MAX_SCALE);
        const contentX = (localX - cur.tx) / cur.scale;
        const contentY = (localY - cur.ty) / cur.scale;
        const next = clampPan(localX - contentX * nextScale, localY - contentY * nextScale, nextScale, viewportSize.w, viewportSize.h);
        return { ...next, scale: nextScale };
      });
    } else {
      setTransform((cur) => {
        const next = clampPan(cur.tx - e.deltaX, cur.ty - e.deltaY, cur.scale, viewportSize.w, viewportSize.h);
        return { ...cur, ...next };
      });
    }
  }
  handleWheelRef.current = handleWheel;

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const listener = (e: WheelEvent) => handleWheelRef.current(e);
    el.addEventListener('wheel', listener, { passive: false });
    return () => el.removeEventListener('wheel', listener);
  }, []);

  return (
    <div className="flex h-full w-full flex-col">
      <div
        ref={viewportRef}
        data-artifact-canvas-viewport
        className="relative min-h-0 w-full flex-1 touch-none overflow-hidden rounded-lg border border-border bg-muted/20"
        style={{ cursor: isDragging ? 'grabbing' : 'grab' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <div
          ref={contentRef}
          data-artifact-canvas-content
          className="absolute top-0 left-0"
          style={{
            width: bounds.w, height: bounds.h,
            transform: `translate(${transform.tx}px, ${transform.ty}px) scale(${transform.scale})`,
            transformOrigin: '0 0',
          }}
        >
          {format === 'html' ? (
            <iframe
              title={title}
              srcDoc={content}
              sandbox=""
              className="pointer-events-none rounded-lg bg-background"
              style={{ width: bounds.w, height: bounds.h }}
            />
          ) : format === 'image' ? (
            // eslint-disable-next-line @next/next/no-img-element -- artifact content는 외부/동적 URL이라 next/image 화이트리스트와 안 맞음.
            <img
              src={content}
              alt={title}
              className="pointer-events-none block h-full w-full rounded-lg object-contain"
              onLoad={(e) => {
                const img = e.currentTarget;
                if (img.naturalWidth > 0 && img.naturalHeight > 0) setImageBounds({ w: img.naturalWidth, h: img.naturalHeight });
              }}
            />
          ) : mode === 'edit' ? null : (
            <TreeStageContent content={content} placeholder={t('treeRenderPlaceholder')} />
          )}
          {overlay ? (
            <div
              data-artifact-canvas-overlay
              className="absolute inset-0"
              style={{ pointerEvents: isDragging ? 'none' : 'auto' }}
            >
              {overlay}
            </div>
          ) : null}
        </div>
      </div>
      <div className="mt-1.5 flex shrink-0 items-center justify-between gap-2">
        <p className="text-[11px] text-muted-foreground">{t(isTouchDevice ? 'viewerCanvasHintTouch' : 'viewerCanvasHint')}</p>
        <div className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
          <span className="tabular-nums">{Math.round(transform.scale * 100)}%</span>
          <button type="button" onClick={fitToView} title={t('viewerFitAction')} className="flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 hover:bg-muted hover:text-foreground">
            <Scan className="size-3" aria-hidden />
            {t('viewerFitAction')}
          </button>
          <button type="button" onClick={actualSize} title={t('viewerActualSizeAction')} className="flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 hover:bg-muted hover:text-foreground">
            <Maximize2 className="size-3" aria-hidden />
            {t('viewerActualSizeAction')}
          </button>
        </div>
      </div>
    </div>
  );
}

function TreeStageContent({ content, placeholder }: { content: string; placeholder: string }) {
  const tree = parseArtifactTree(content);
  if (!tree) {
    return <p className="pointer-events-none p-4 text-xs text-muted-foreground">{placeholder}</p>;
  }
  return (
    <div className="pointer-events-none h-full w-full space-y-2 overflow-hidden rounded-lg bg-background p-2">
      {tree.map((node) => <TreeNodeBox key={node.id} node={node} />)}
    </div>
  );
}

/**
 * 포맷별 렌더 스테이지 — 이제 3포맷 전부 같은 `CanvasViewport` 엔진(transform pan/zoom)을
 * 공유한다(story 1948d19d §1~§3). 완전 잠금 샌드박스 iframe(`sandbox=""` — allow-scripts·
 * allow-same-origin 둘 다 없음, 핸드오프 §3-1 + 유나 디자인 가디언 보안 지적 반영) 유지 —
 * pointer-events:none이 상호작용 레이어와 물리적으로 분리해 완화가 애초에 불필요.
 */
export function ArtifactStage({ format, content, title, canvasBounds, overlay, mode, contentRef, previewWidth }: ArtifactStageProps) {
  return <CanvasViewport format={format} content={content} title={title} canvasBounds={canvasBounds} overlay={overlay} mode={mode} contentRef={contentRef} previewWidth={previewWidth} />;
}
