import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import type { ArtifactFormat } from '@/services/canvas';

/**
 * story 385eb89a — 고정 넓이 html_blob 잘림 대책. sandbox=""(allow-same-origin 없음)라 iframe
 * 내부 문서 폭을 측정할 수 없어(cross-origin) 실 콘텐츠 폭을 알 방법이 없다 — 대신 iframe 자체
 * 박스를 이 고정 "캔버스" 폭으로 렌더해 내용이 접히지 않게 하고, wrapper가 스크롤한다.
 *
 * story d425dccc — v1의 축소-fit "전체 보기" 토글은 선생님 실사용 결과 제거(유나 스펙 ⓒ 판정 —
 * 축소는 디테일을 못 보게 해 원하는 것과 반대). 대신 ⓐ space+드래그 pan ⓑ 가로 스크롤바 상시
 * 가시화로 대체 — wrapper는 항상 실제 크기로 렌더하고 이동 수단만 강화한다.
 */
const HTML_STAGE_WIDTH = 1200;
const HTML_STAGE_HEIGHT = 280;

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

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA']);

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return TYPING_TAGS.has(target.tagName) || target.isContentEditable;
}

interface ArtifactStageProps {
  format: ArtifactFormat;
  content: string;
  title: string;
  /** story d425dccc — "크게 보기" 모달 전용. true면 인라인 프리뷰의 고정 280px 대신 부모
   * 컨테이너 높이를 꽉 채운다(더 넓은 뷰포트로 스크롤/pan 부담을 줄이는 게 모달의 목적).
   * html 포맷 외엔 무시. */
  fill?: boolean;
}

/**
 * html 산출물의 space+드래그 pan(story d425dccc). sandbox=""(allow-scripts 없음) iframe은
 * 자기 자신의 포인터 이벤트를 소비해 드래그가 iframe 경계에서 끊기므로, 투명 오버레이(우리
 * DOM)로 포인터를 가로채는 방식으로 우회한다 — sandbox 완화 없음(iframe 내부는 여전히 0접근).
 * space를 누르고 있을 때만 오버레이가 pointer-events를 받아 grab/grabbing 커서로 드래그하고,
 * 뗄 때 원복(iframe 자체 상호작용에 지장 없음).
 */
function PanOverlay({ wrapperRef }: { wrapperRef: React.RefObject<HTMLDivElement | null> }) {
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [dragging, setDragging] = useState(false);
  const hoveringRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0, scrollLeft: 0, scrollTop: 0 });

  // hover 감지는 wrapper(스크롤 컨테이너)에 직접 건다 — 오버레이 자신은 space 안 눌렀을 때
  // pointer-events:none이라 자기 위의 mouseenter/leave를 못 받는다(순환 의존 방지).
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    function onEnter() { hoveringRef.current = true; }
    function onLeave() { hoveringRef.current = false; }
    el.addEventListener('mouseenter', onEnter);
    el.addEventListener('mouseleave', onLeave);
    return () => {
      el.removeEventListener('mouseenter', onEnter);
      el.removeEventListener('mouseleave', onLeave);
    };
  }, [wrapperRef]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.code !== 'Space' || !hoveringRef.current || isTypingTarget(e.target)) return;
      e.preventDefault(); // 페이지 스크롤(space=page down) 억제
      setSpaceHeld(true);
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.code !== 'Space') return;
      setSpaceHeld(false);
      setDragging(false);
    }
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  useEffect(() => {
    if (!dragging) return;
    function onMouseMove(e: MouseEvent) {
      const el = wrapperRef.current;
      if (!el) return;
      const { x, y, scrollLeft, scrollTop } = dragStartRef.current;
      el.scrollLeft = scrollLeft - (e.clientX - x);
      el.scrollTop = scrollTop - (e.clientY - y);
    }
    function onMouseUp() {
      setDragging(false);
    }
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [dragging, wrapperRef]);

  function handleMouseDown(e: React.MouseEvent) {
    if (!spaceHeld) return;
    const el = wrapperRef.current;
    if (!el) return;
    dragStartRef.current = { x: e.clientX, y: e.clientY, scrollLeft: el.scrollLeft, scrollTop: el.scrollTop };
    setDragging(true);
  }

  return (
    <div
      role="presentation"
      data-pan-overlay
      data-pan-active={spaceHeld || undefined}
      onMouseDown={handleMouseDown}
      className="absolute inset-0"
      style={{
        pointerEvents: spaceHeld ? 'auto' : 'none',
        cursor: dragging ? 'grabbing' : spaceHeld ? 'grab' : undefined,
      }}
    />
  );
}

/**
 * 포맷별 렌더 스테이지. html=완전 잠금 샌드박스 iframe(`sandbox=""` — allow-scripts·
 * allow-same-origin 둘 다 없음, 핸드오프 §3-1 + 유나 디자인 가디언 보안 지적 반영).
 * artifact HTML은 인라인 `<style>`만 쓰므로 same-origin 리소스 접근이 필요 없어 최대
 * 잠금이 안전(CSS 렌더링은 sandbox 플래그와 무관하게 항상 동작함)·image=바운드 img·
 * tree=경량 노드 렌더(전신 componentCatalog의 리치 렌더는 후속 — 지금은 shell 준비 단계).
 */
export function ArtifactStage({ format, content, title, fill = false }: ArtifactStageProps) {
  const t = useTranslations('canvas');
  const wrapperRef = useRef<HTMLDivElement>(null);

  if (format === 'html') {
    return (
      <div className={fill ? 'flex h-full w-full flex-col' : 'w-full'}>
        {/* overlay는 스크롤 컨테이너 밖(형제)에 둔다 — 안에 두면 pan으로 스크롤될 때 overlay
         * 자신도 같이 밀려나 뷰포트 밖으로 나가버린다(자기 자신이 캡처하는 영역을 잃는 순환
         * 버그). 밖에 두면 wrapper의 보이는 영역(clientHeight)에 항상 고정된다. */}
        <div className={fill ? 'relative min-h-0 w-full flex-1' : 'relative w-full'}>
          <div
            ref={wrapperRef}
            data-artifact-stage-scroll
            className={cn('w-full overflow-auto rounded-lg border border-border bg-background', fill && 'h-full')}
            style={{ scrollbarGutter: 'stable' }}
          >
            <iframe
              title={title}
              srcDoc={content}
              sandbox=""
              className="rounded-lg"
              style={{ width: HTML_STAGE_WIDTH, height: fill ? '100%' : HTML_STAGE_HEIGHT }}
            />
          </div>
          <PanOverlay wrapperRef={wrapperRef} />
        </div>
        <p className="mt-1.5 shrink-0 text-[11px] text-muted-foreground">{t('viewerPanHint')}</p>
      </div>
    );
  }

  if (format === 'image') {
    // eslint-disable-next-line @next/next/no-img-element -- artifact content는 외부/동적 URL(임의 도메인)이라 next/image 도메인 화이트리스트와 안 맞음.
    return <img src={content} alt={title} className="mx-auto max-h-[420px] max-w-full rounded-lg object-contain" />;
  }

  const tree = parseArtifactTree(content);
  if (!tree) {
    return <p className="p-4 text-xs text-muted-foreground">{t('treeRenderPlaceholder')}</p>;
  }
  return (
    <div className="space-y-2 p-2">
      {tree.map((node) => <TreeNodeBox key={node.id} node={node} />)}
    </div>
  );
}
