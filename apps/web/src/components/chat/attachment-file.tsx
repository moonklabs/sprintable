'use client';

import { useCallback, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useToast } from '@/components/ui/toast';

/**
 * a54ddc16 — 비-이미지 첨부 다운로드를 auth-gated 서명 라우트 경유로 처리한다.
 * 클릭 시 `/api/attachments/sign`으로 단기 서명 URL을 받아 새 탭으로 연다(public 직링크 미사용).
 */
interface AttachmentFileProps {
  storedUrl: string;
  // 첨부가 속한 리소스 — conversation(채팅) 또는 story(보드). 정확히 하나.
  conversationId?: string;
  storyId?: string;
  label: string;
  Icon: LucideIcon;
  /** story #2766(레인 A) — 채팅 호출부가 물려주면 클릭 시 새 탭 대신 ReadingPanel을 연다
   * (서명 URL 자체는 패널이 직접 뜬다 — 여기선 target 정보만 전달). 생략하면(undefined,
   * docs/kanban 등 채팅 밖 기존 호출부) 기존 window.open 다운로드 그대로 — 회귀 없음. */
  onOpenPanel?: (target: { storedUrl: string; conversationId?: string; storyId?: string; label: string; contentType?: string | null; assetId?: string }) => void;
  contentType?: string | null;
  /** story #2803 — 백엔드가 메시지 전송 시 asset registry에 역기입하는 denorm 필드
   * (asset_registry.sync_attachment_assets). pptx 변환(POST /convert)은 asset_id 축이라
   * 이게 있어야 그 뷰어 케이스가 동작한다 — 없으면(구 메시지 등) office 폴백으로 정직 축소. */
  assetId?: string;
}

export function AttachmentFile({ storedUrl, conversationId, storyId, label, Icon, onOpenPanel, contentType, assetId }: AttachmentFileProps) {
  const t = useTranslations('chats');
  const { addToast } = useToast();
  const [loading, setLoading] = useState(false);

  const open = useCallback(async () => {
    if (onOpenPanel) {
      onOpenPanel({ storedUrl, conversationId, storyId, label, contentType, assetId });
      return;
    }
    if (loading) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ path: storedUrl });
      if (conversationId) params.set('conversation_id', conversationId);
      else if (storyId) params.set('story_id', storyId);
      const res = await fetch(`/api/attachments/sign?${params.toString()}`);
      if (res.status === 403) {
        addToast({ type: 'info', title: t('attachmentDenied') });
        return;
      }
      const json = (await res.json().catch(() => null)) as { data?: { url?: string } } | null;
      const url = json?.data?.url;
      if (!res.ok || !url) {
        addToast({ type: 'error', title: t('attachmentReload') });
        return;
      }
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      addToast({ type: 'error', title: t('attachmentReload') });
    } finally {
      setLoading(false);
    }
  }, [storedUrl, conversationId, storyId, label, contentType, assetId, loading, addToast, t, onOpenPanel]);

  return (
    <button
      type="button"
      onClick={() => void open()}
      disabled={loading}
      className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-xs hover:bg-muted/50 disabled:opacity-60"
    >
      {loading ? <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin text-muted-foreground" /> : <Icon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />}
      <span className="truncate text-foreground">{label}</span>
    </button>
  );
}
