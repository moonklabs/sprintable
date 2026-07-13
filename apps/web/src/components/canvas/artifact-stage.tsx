import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { ArtifactFormat } from '@/services/canvas';

/**
 * story 385eb89a — 고정 넓이 html_blob 잘림 대책. sandbox=""(allow-same-origin 없음)라 iframe
 * 내부 문서 폭을 측정할 수 없어(cross-origin) 실 콘텐츠 폭을 알 방법이 없다 — 대신 iframe 자체
 * 박스를 이 고정 "캔버스" 폭으로 렌더해 내용이 접히지 않게 하고, wrapper가 스크롤(실제 크기)
 * 하거나 wrapper 자기 자신의 폭(우리가 소유한 DOM이라 측정 가능)에 맞춰 transform:scale로
 * 축소(전체 보기)한다 — html_blob 내부 측정은 여전히 0(보안 트레이드오프 유지, canvas-export.ts
 * §PNG export 제외 결정과 동일 원칙).
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

interface ArtifactStageProps {
  format: ArtifactFormat;
  content: string;
  title: string;
  /** html 포맷 전체보기(fit) 토글 — tree/image는 이 prop을 무시(토글 자체가 미노출). */
  fitToView?: boolean;
}

/**
 * 포맷별 렌더 스테이지. html=완전 잠금 샌드박스 iframe(`sandbox=""` — allow-scripts·
 * allow-same-origin 둘 다 없음, 핸드오프 §3-1 + 유나 디자인 가디언 보안 지적 반영).
 * artifact HTML은 인라인 `<style>`만 쓰므로 same-origin 리소스 접근이 필요 없어 최대
 * 잠금이 안전(CSS 렌더링은 sandbox 플래그와 무관하게 항상 동작함)·image=바운드 img·
 * tree=경량 노드 렌더(전신 componentCatalog의 리치 렌더는 후속 — 지금은 shell 준비 단계).
 */
export function ArtifactStage({ format, content, title, fitToView = false }: ArtifactStageProps) {
  const t = useTranslations('canvas');
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [fitRatio, setFitRatio] = useState(1);

  useEffect(() => {
    if (format !== 'html' || !fitToView) return;
    const el = wrapperRef.current;
    if (!el) return;
    const measure = () => setFitRatio(Math.min(1, el.clientWidth / HTML_STAGE_WIDTH));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [format, fitToView]);

  if (format === 'html') {
    return (
      <div
        ref={wrapperRef}
        className="w-full rounded-lg border border-border bg-background"
        style={fitToView
          ? { height: HTML_STAGE_HEIGHT * fitRatio, overflow: 'hidden' }
          : { overflowX: 'auto' }}
      >
        <iframe
          title={title}
          srcDoc={content}
          sandbox=""
          className="rounded-lg"
          style={{
            width: HTML_STAGE_WIDTH,
            height: HTML_STAGE_HEIGHT,
            transform: fitToView ? `scale(${fitRatio})` : undefined,
            transformOrigin: 'top left',
          }}
        />
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
