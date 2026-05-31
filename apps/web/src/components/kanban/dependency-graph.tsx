'use client';

import type { DependencyEdge } from './types';

interface DependencyGraphProps {
  storyId: string;
  deps: DependencyEdge[];
  storyMap: Record<string, { title: string; status: string }>;
  onNavigate?: (storyId: string) => void;
}

const MAX_SIDE = 4;

function nodeColor(status: string | undefined, isCurrent: boolean) {
  if (isCurrent) return { fill: 'var(--color-brand, #6366f1)', text: '#fff', stroke: 'var(--color-brand, #6366f1)' };
  if (status === 'done') return { fill: 'var(--color-success-tint, #d1fae5)', text: 'var(--color-success, #059669)', stroke: 'var(--color-success-border, #6ee7b7)' };
  return { fill: 'var(--color-info-tint, #e0f2fe)', text: 'var(--color-info, #0284c7)', stroke: 'var(--color-info-border, #7dd3fc)' };
}

export function DependencyGraph({ storyId, deps, storyMap, onNavigate }: DependencyGraphProps) {
  const blockers = deps.filter((d) => d.dep_type === 'blocks' && d.to_id === storyId);
  const blockeds = deps.filter((d) => d.dep_type === 'blocks' && d.from_id === storyId);
  const dependsOn = deps.filter((d) => d.dep_type === 'depends_on' && d.from_id === storyId);
  const dependedBy = deps.filter((d) => d.dep_type === 'depends_on' && d.to_id === storyId);

  const leftItems = [...blockers, ...dependedBy];
  const rightItems = [...blockeds, ...dependsOn];

  const leftVisible = leftItems.slice(0, MAX_SIDE);
  const rightVisible = rightItems.slice(0, MAX_SIDE);
  const leftExtra = leftItems.length - leftVisible.length;
  const rightExtra = rightItems.length - rightVisible.length;

  const nodeH = 28;
  const nodeW = 120;
  const gapY = 10;
  const leftCount = leftVisible.length + (leftExtra > 0 ? 1 : 0);
  const rightCount = rightVisible.length + (rightExtra > 0 ? 1 : 0);
  const sideCount = Math.max(leftCount, rightCount, 1);
  const svgH = Math.max(sideCount * (nodeH + gapY) - gapY, nodeH + 20);
  const svgW = 360;
  const centerX = svgW / 2;
  const currentY = svgH / 2 - nodeH / 2;

  function sideY(idx: number, total: number) {
    const totalH = total * (nodeH + gapY) - gapY;
    const startY = svgH / 2 - totalH / 2;
    return startY + idx * (nodeH + gapY);
  }

  function shortTitle(id: string) {
    return storyMap[id]?.title?.slice(0, 14) ?? `#${id.slice(0, 6)}`;
  }

  return (
    <svg
      viewBox={`0 0 ${svgW} ${svgH}`}
      width="100%"
      style={{ maxHeight: 200 }}
      className="overflow-visible"
      aria-label="Dependency graph"
    >
      {/* Left nodes */}
      {leftVisible.map((d, i) => {
        const otherId = d.dep_type === 'blocks' ? d.from_id : d.from_id;
        const status = storyMap[otherId]?.status;
        const { fill, text, stroke } = nodeColor(status, false);
        const y = sideY(i, leftCount);
        const mx = nodeW + 20;
        const ny = y + nodeH / 2;
        return (
          <g key={d.id}>
            <line x1={mx} y1={ny} x2={centerX - nodeW / 2 - 2} y2={currentY + nodeH / 2} stroke="var(--color-border, #e5e7eb)" strokeWidth={1.5} markerEnd={d.dep_type === 'blocks' ? 'url(#arrow)' : undefined} strokeDasharray={d.dep_type === 'depends_on' ? '4 2' : undefined} />
            <rect x={0} y={y} width={nodeW} height={nodeH} rx={6} fill={fill} stroke={stroke} strokeWidth={1.5} style={{ cursor: onNavigate ? 'pointer' : 'default' }} onClick={() => onNavigate?.(otherId)} />
            <text x={nodeW / 2} y={y + nodeH / 2 + 4} textAnchor="middle" fontSize={10} fill={text} style={{ pointerEvents: 'none' }}>{shortTitle(otherId)}</text>
          </g>
        );
      })}
      {leftExtra > 0 && (
        <g>
          <rect x={0} y={sideY(leftVisible.length, leftCount)} width={nodeW} height={nodeH} rx={6} fill="var(--color-muted, #f3f4f6)" stroke="var(--color-border, #e5e7eb)" strokeWidth={1.5} />
          <text x={nodeW / 2} y={sideY(leftVisible.length, leftCount) + nodeH / 2 + 4} textAnchor="middle" fontSize={10} fill="var(--color-muted-foreground, #6b7280)">+{leftExtra} more</text>
        </g>
      )}

      {/* Current node */}
      {(() => {
        const { fill, text, stroke } = nodeColor(undefined, true);
        const currentTitle = storyMap[storyId]?.title?.slice(0, 14) ?? `#${storyId.slice(0, 6)}`;
        return (
          <g>
            <rect x={centerX - nodeW / 2} y={currentY} width={nodeW} height={nodeH} rx={6} fill={fill} stroke={stroke} strokeWidth={2} />
            <text x={centerX} y={currentY + nodeH / 2 + 4} textAnchor="middle" fontSize={10} fontWeight="600" fill={text}>{currentTitle}</text>
          </g>
        );
      })()}

      {/* Right nodes */}
      {rightVisible.map((d, i) => {
        const otherId = d.dep_type === 'blocks' ? d.to_id : d.to_id;
        const status = storyMap[otherId]?.status;
        const { fill, text, stroke } = nodeColor(status, false);
        const y = sideY(i, rightCount);
        const rx = svgW - nodeW;
        const ny = y + nodeH / 2;
        return (
          <g key={d.id}>
            <line x1={centerX + nodeW / 2 + 2} y1={currentY + nodeH / 2} x2={rx - 2} y2={ny} stroke="var(--color-border, #e5e7eb)" strokeWidth={1.5} markerEnd={d.dep_type === 'blocks' ? 'url(#arrow)' : undefined} strokeDasharray={d.dep_type === 'depends_on' ? '4 2' : undefined} />
            <rect x={rx} y={y} width={nodeW} height={nodeH} rx={6} fill={fill} stroke={stroke} strokeWidth={1.5} style={{ cursor: onNavigate ? 'pointer' : 'default' }} onClick={() => onNavigate?.(otherId)} />
            <text x={rx + nodeW / 2} y={y + nodeH / 2 + 4} textAnchor="middle" fontSize={10} fill={text} style={{ pointerEvents: 'none' }}>{shortTitle(otherId)}</text>
          </g>
        );
      })}
      {rightExtra > 0 && (
        <g>
          <rect x={svgW - nodeW} y={sideY(rightVisible.length, rightCount)} width={nodeW} height={nodeH} rx={6} fill="var(--color-muted, #f3f4f6)" stroke="var(--color-border, #e5e7eb)" strokeWidth={1.5} />
          <text x={svgW - nodeW / 2} y={sideY(rightVisible.length, rightCount) + nodeH / 2 + 4} textAnchor="middle" fontSize={10} fill="var(--color-muted-foreground, #6b7280)">+{rightExtra} more</text>
        </g>
      )}

      <defs>
        <marker id="arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
          <path d="M0,0 L0,6 L6,3 z" fill="var(--color-border, #e5e7eb)" />
        </marker>
      </defs>
    </svg>
  );
}
