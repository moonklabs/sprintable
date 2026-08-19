'use client';

import { EntityPreviewModal } from '@/components/chat/embed-card';
import { FileViewer } from '@/components/chat/file-viewer';

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

/**
 * 인계 doc 0ef7f8ab §A1 — thread-panel.tsx 선례(데스크톱 나란히·모바일 전체화면 드로어)를
 * 그대로 따르되, 폭은 부모(chat-view.tsx)가 clamp(480px,40vw,720px)로 강제한다(⛔base
 * DialogContent의 sm:max-w-sm 상속 금지 — 애초에 Dialog를 안 쓰므로 상속될 여지가 없다).
 * 채팅 입력은 이 패널이 열려도 그대로 활성 — ThreadPanel과 달리 이 컴포넌트는 자기 폭 밖의
 * 레이아웃(모달 아님·오버레이 아님)에 개입하지 않는다.
 */
export function ReadingPanel({ target, onClose }: { target: ReadingPanelTarget; onClose: () => void }) {
  if (target.kind === 'entity') {
    return (
      <div className="flex h-full flex-col overflow-hidden border-l border-border bg-background">
        <EntityPreviewModal
          entityType={target.entityType}
          entityId={target.entityId}
          title={target.title}
          status={target.status}
          href={target.href}
          onClose={onClose}
          embedded
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden border-l border-border bg-background">
      <FileViewer target={target} onClose={onClose} />
    </div>
  );
}
