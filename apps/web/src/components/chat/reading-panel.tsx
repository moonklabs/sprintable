'use client';

import { EntityPreviewModal } from '@/components/chat/embed-card';
import { EntityGlyph, resolveEntityIcon } from '@/components/chat/entity-registry';
import { FileViewer } from '@/components/chat/file-viewer';
import { getFileIcon } from '@/lib/file-icon';
import { X } from 'lucide-react';

/**
 * story #2766(레인 A)·#2780(엔티티 확장)·#2781(asset 편입) — 채팅을 벗어나지 않는 우측 리딩
 * 패널의 대상 2형태. ①엔티티 읽기 뷰(story/epic/doc/hypothesis/artifact/task/sprint —
 * EntityPreviewModal embedded 재사용, 타입별 분기는 그 내부(EntityDetail)에만 있다) ②파일류
 * (FileViewer) — 채팅 첨부(storedUrl+conversationId/storyId)와 스토리지 asset(assetId) 둘 다
 * 이 kind 하나로 들어온다. sign 방식만 다르다(파일 signer가 정확히 하나만 요구·file-viewer.tsx
 * signAttachment 참고) — 소비부(FileViewer 본체)는 동일.
 */
export type ReadingPanelTarget =
  | { kind: 'entity'; entityType: string; entityId: string; title: string | null; status: string | null; href: string | null }
  | {
      kind: 'attachment';
      label: string;
      contentType?: string | null;
      storedUrl?: string;
      conversationId?: string;
      storyId?: string;
      assetId?: string;
    };

function targetLabel(target: ReadingPanelTarget): string {
  return target.kind === 'entity' ? (target.title ?? target.entityId) : target.label;
}

function TargetGlyph({ target, className }: { target: ReadingPanelTarget; className?: string }) {
  const label = targetLabel(target);
  const Icon = target.kind === 'entity' ? resolveEntityIcon(target.entityType) : getFileIcon(target.contentType);
  return <EntityGlyph Icon={Icon} label={label} className={className} />;
}

function ReadingPanelContent({ target, onClose }: { target: ReadingPanelTarget; onClose: () => void }) {
  if (target.kind === 'entity') {
    return (
      <EntityPreviewModal
        entityType={target.entityType}
        entityId={target.entityId}
        title={target.title}
        status={target.status}
        href={target.href}
        onClose={onClose}
        embedded
      />
    );
  }
  return <FileViewer target={target} onClose={onClose} />;
}

/**
 * story #2888/S2(임베드 뼈대) R5 — 인계 doc 0ef7f8ab §A1(thread-panel.tsx 선례: 데스크톱
 * 나란히·모바일 전체화면 드로어)에 스택(push/pop·브레드크럼)을 얹는다. 폭은 부모
 * (chat-view.tsx)가 clamp(480px,40vw,720px)로 강제(⛔Dialog 미사용이라 sm:max-w-sm 상속 여지
 * 자체가 없음). 채팅 입력은 이 패널이 열려도 그대로 활성.
 *
 * **스택 규칙**(S2 스펙 §4·유나군 목업 s2d-sidepane-stack-mockup): 최대 깊이 3 — 부모
 * (chat-view.tsx openReadingPanel)가 초과분을 최하단부터 pop해 이 컴포넌트에 넘긴다(이
 * 컴포넌트는 스택 길이를 강제하지 않고 받은 그대로 그린다). 콘텐츠 자체의 자기 X(닫기)는
 * "한 단계 뒤로"(pop) — 스택에 1개뿐이면 그게 곧 전체 닫기와 같다. 브레드크럼 우측의 별도
 * X는 "전체 닫기"(스택 전부 버리기, onClose).
 */
export function ReadingPanel({
  stack, onNavigateTo, onClose,
}: {
  stack: ReadingPanelTarget[];
  /** 브레드크럼 세그먼트 클릭 — 그 인덱스까지 pop(그 항목이 새 최상단이 된다). */
  onNavigateTo: (index: number) => void;
  /** 전체 닫기(스택 전부 버림) — 브레드크럼 X, 최상단 콘텐츠 자기 X 둘 다(콘텐츠 쪽은 "한 단계
   * 뒤로"가 되도록 호출부가 stack.length에 따라 onNavigateTo/onClose 중 골라 넘긴다). */
  onClose: () => void;
}) {
  const top = stack[stack.length - 1];
  if (!top) return null;

  const popOne = stack.length > 1 ? () => onNavigateTo(stack.length - 2) : onClose;

  return (
    <div className="flex h-full flex-col overflow-hidden border-l border-border bg-background">
      {stack.length > 1 && (
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2 py-1.5">
          {stack.map((item, i) => {
            const isLast = i === stack.length - 1;
            return (
              <div key={i} className="flex shrink-0 items-center gap-1">
                {i > 0 && <span className="text-xs text-border">›</span>}
                <button
                  type="button"
                  onClick={() => onNavigateTo(i)}
                  disabled={isLast}
                  className={`flex max-w-32 items-center gap-1 rounded px-1.5 py-1 text-xs ${
                    isLast ? 'font-medium text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                  }`}
                  title={targetLabel(item)}
                >
                  <TargetGlyph target={item} className="size-3 shrink-0" />
                  <span className="truncate">{targetLabel(item)}</span>
                </button>
              </div>
            );
          })}
          <button
            type="button"
            onClick={onClose}
            aria-label="전체 닫기"
            title="전체 닫기"
            className="ml-auto shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}
      <div
        // story #2910(S2f/R3) — 스택 top이 바뀔 때마다(어느 방향이든) 확실히 리마운트 — 대상
        // 정체성 자체를 key로(stack.length만으론 pop→다른 대상 push가 같은 길이일 때 리마운트가
        // 안 됨). 리마운트가 slide-up+fade를 push/pop 매번 자연 재발화시킨다(exit 애니는 의도적
        // 무 — PO 판정 2026-08-21: 즉시 사라짐=반응성 피드백, isClosing 지연-unmount는 스택
        // 동역학 테스트 부채(#2904) 자리에 회귀 반경만 키움).
        key={top.kind === 'entity' ? `entity:${top.entityType}:${top.entityId}` : `attachment:${top.assetId ?? top.storedUrl ?? top.label}`}
        className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 flex min-h-0 flex-1 flex-col overflow-hidden duration-150"
      >
        <ReadingPanelContent target={top} onClose={popOne} />
      </div>
    </div>
  );
}
