'use client';

import { useCallback, useRef, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { Bot, MessageSquare, Terminal, User } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ChatMessage } from '@/hooks/use-chat-sse';
import { commandName, dequoteLiteral, isCommand } from '@/lib/command-classifier';
import { EntityChip, getEntityHref } from '@/components/chat/embed-card';
import { getFileIcon } from '@/lib/file-icon';
import { AttachmentImage } from './attachment-image';
import { AttachmentFile } from './attachment-file';
import { MessageContextMenu } from './message-context-menu';
import { PresenceDot, WORKING_RING_CLASS, type PresenceStatus } from './presence-dot';

interface ChatBubbleProps {
  message: ChatMessage;
  isMine: boolean;
  isGrouped?: boolean;
  onOpenThread?: (message: ChatMessage) => void;
  onDelete?: (messageId: string) => void;
  // 1aeecdde P2: 2축 presence — 연결(dot) + 활동(working ring). 에이전트 sender만 적용.
  presenceStatus?: PresenceStatus | null;
  isWorking?: boolean;
}

interface ContextMenuState {
  x: number;
  y: number;
}

// Convert @name tokens to markdown links so react-markdown v10 can render them via the `a` component.
// Uses negative lookbehind to skip already-linked mentions (e.g. inside [...]).
function prepareMentions(content: string): string {
  return content.replace(/(?<![[(])@([\w가-힣]+)/g, '[@$1](mention:$1)');
}

function ChatMarkdown({ content, isMine }: { content: string; isMine: boolean }) {
  const text = isMine ? 'text-primary-foreground' : 'text-foreground';
  const muted = isMine ? 'text-primary-foreground/70' : 'text-muted-foreground';
  const codeBg = isMine ? 'bg-primary-foreground/10 text-primary-foreground' : 'bg-muted text-foreground';
  const border = isMine ? 'border-primary-foreground/30' : 'border-border';

  const hasMention = /@[\w가-힣]+/.test(content);
  const hasMarkdown = /[*_`#\[\]>~]|entity:/.test(content);

  if (!hasMarkdown && !hasMention) {
    return (
      <span className={`whitespace-pre-wrap [overflow-wrap:anywhere] text-sm leading-relaxed ${text}`}>
        {content}
      </span>
    );
  }

  const prepared = hasMention ? prepareMentions(content) : content;

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkBreaks]}
      urlTransform={(url) =>
        url.startsWith('entity:') || url.startsWith('mention:') ? url : defaultUrlTransform(url)
      }
      components={{
        p: ({ children }) => <p className={`mb-1.5 [overflow-wrap:anywhere] text-sm leading-relaxed last:mb-0 ${text}`}>{children}</p>,
        strong: ({ children }) => <strong className={`font-semibold ${text}`}>{children}</strong>,
        em: ({ children }) => <em className={`italic ${text}`}>{children}</em>,
        code: ({ children }) => <code className={`rounded px-1 py-0.5 font-mono text-xs [overflow-wrap:anywhere] ${codeBg}`}>{children}</code>,
        pre: ({ children }) => <pre className={`mb-1.5 overflow-x-auto rounded-lg p-2.5 text-xs ${codeBg}`}>{children}</pre>,
        ul: ({ children }) => <ul className={`mb-1.5 ml-4 list-disc space-y-0.5 text-sm ${text}`}>{children}</ul>,
        ol: ({ children }) => <ol className={`mb-1.5 ml-4 list-decimal space-y-0.5 text-sm ${text}`}>{children}</ol>,
        li: ({ children }) => <li className={`text-sm leading-relaxed ${text}`}>{children}</li>,
        blockquote: ({ children }) => <blockquote className={`mb-1.5 border-l-2 pl-3 ${border} ${muted}`}>{children}</blockquote>,
        a: ({ href, children }) => {
          if (href?.startsWith('mention:')) {
            return (
              <span className={`font-medium ${isMine ? 'text-primary-foreground underline decoration-primary-foreground/40' : 'text-primary'}`}>
                {children}
              </span>
            );
          }
          const m = href?.match(/^entity:(\w+):([0-9a-f-]+)$/i);
          if (m) {
            return <EntityChip entityType={m[1]!} entityId={m[2]!} label={String(children)} href={getEntityHref(m[1]!, m[2]!)} />;
          }
          return <a href={href} target="_blank" rel="noopener noreferrer" className={`underline underline-offset-2 ${text}`}>{children}</a>;
        },
      }}
    >
      {prepared}
    </ReactMarkdown>
  );
}

const LONG_PRESS_MS = 500;

export function ChatBubble({ message, isMine, isGrouped = false, onOpenThread, onDelete, presenceStatus, isWorking = false }: ChatBubbleProps) {
  const t = useTranslations('chats');
  const isAgent = message.sender_type === 'agent';
  // S8: 슬래시 커맨드는 전용 버블(brand·mono·⌘). 리터럴(`//`)은 dequote된 일반 텍스트.
  const isCmd = isCommand(message.content);
  const isLiteral = !isCmd && message.content.startsWith('//');
  const displayContent = isLiteral ? dequoteLiteral(message.content) : message.content;
  const cmdName = isCmd ? commandName(message.content) : null;
  const displayName = isMine ? '나' : (message.sender_name || '팀');
  const time = new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit' }).format(new Date(message.created_at));
  const replyCount = message.reply_count ?? 0;
  const lastReplyAt = message.last_reply_at;

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchPosRef = useRef<{ x: number; y: number } | null>(null);

  // AC1: 우클릭 컨텍스트 메뉴 (데스크톱)
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  // AC2: 롱프레스 컨텍스트 메뉴 (모바일)
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;
    touchPosRef.current = { x: touch.clientX, y: touch.clientY };
    longPressTimerRef.current = setTimeout(() => {
      if (touchPosRef.current) {
        setContextMenu({ x: touchPosRef.current.x, y: touchPosRef.current.y });
      }
    }, LONG_PRESS_MS);
  }, []);

  const handleTouchEnd = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    touchPosRef.current = null;
  }, []);

  const handleTouchMove = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(message.content);
  }, [message.content]);

  const handleDelete = useCallback(() => {
    onDelete?.(message.id);
  }, [message.id, onDelete]);

  const handleOpenThread = useCallback(() => {
    onOpenThread?.(message);
  }, [message, onOpenThread]);

  const lastReplyTime = lastReplyAt
    ? new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit' }).format(new Date(lastReplyAt))
    : null;

  return (
    <>
      <div
        className={`flex gap-2 ${isMine ? 'flex-row-reverse' : 'flex-row'} ${isGrouped ? 'mt-0.5' : 'mt-2'}`}
        onContextMenu={handleContextMenu}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        onTouchMove={handleTouchMove}
      >
        {/* Avatar — hidden when grouped. 1aeecdde P2: agent에 연결 dot + working ring(2축). */}
        {isGrouped ? (
          <div className="w-7 flex-shrink-0" />
        ) : (
          <div className="relative h-7 w-7 flex-shrink-0">
            <div className={`flex h-full w-full items-center justify-center rounded-full text-xs font-medium ${
              isAgent
                ? 'bg-accent-claim/15 text-accent-claim'
                : isMine
                  ? 'bg-primary/20 text-primary'
                  : 'bg-muted text-muted-foreground'
            } ${isAgent && isWorking ? WORKING_RING_CLASS : ''}`}>
              {isAgent ? <Bot className="h-3.5 w-3.5" /> : <User className="h-3.5 w-3.5" />}
            </div>
            {isAgent && presenceStatus ? (
              <PresenceDot status={presenceStatus} className="absolute -bottom-0.5 -right-0.5" />
            ) : null}
          </div>
        )}

        {/* Bubble + meta. min-w-0 breaks the flex min-width:auto trap (d67e5478): without it
            a long unbreakable code line/URL's min-content overrides max-w-[72%] and overflows
            the row → page. With it, the column respects max-w and the inner content contains
            itself — whitespace-pre-wrap code wraps, <pre> scrolls (overflow-x-auto), URLs break. */}
        <div className={`flex min-w-0 max-w-[72%] flex-col gap-0.5 ${isMine ? 'items-end' : 'items-start'}`}>
          {/* Sender name — hidden when grouped */}
          {!isGrouped && (
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] font-medium text-muted-foreground">{displayName}</span>
              {isAgent && (
                <span className="rounded-sm bg-accent-claim/15 px-1 py-0.5 text-[9px] font-medium text-accent-claim">
                  Bot
                </span>
              )}
            </div>
          )}

          {/* Content — S8: command 전용 버블(brand·mono·⌘ 태그) vs 일반(리터럴은 dequote 표시) */}
          {isCmd ? (
            <div className={`rounded-xl border border-info/30 bg-info/8 px-3.5 py-2 ${isMine ? 'rounded-tr-sm' : 'rounded-tl-sm'}`}>
              <div className="mb-1 flex items-center gap-1 text-[10px] font-medium text-info">
                <Terminal className="h-3 w-3" aria-hidden />
                {t('commandTag')}
              </div>
              <code className="block whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-sm">
                <span className="text-info">/{cmdName}</span>
                <span className="text-muted-foreground">{message.content.slice(1 + (cmdName?.length ?? 0))}</span>
              </code>
            </div>
          ) : (
            <div className={`rounded-xl px-3.5 py-2 text-sm leading-relaxed [overflow-wrap:anywhere] ${
              isMine
                ? 'rounded-tr-sm bg-primary text-primary-foreground'
                : 'rounded-tl-sm bg-muted text-foreground'
            }`}>
              <ChatMarkdown content={displayContent} isMine={isMine} />
            </div>
          )}

          {/* Attachments — a54ddc16: auth-gated 서명 라우트 경유(public 직링크 미사용).
              이미지=AttachmentImage(3상태 render)·그 외=AttachmentFile(클릭 시 서명 다운로드). */}
          {message.attachments && message.attachments.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {message.attachments.map((att, i) => {
                const href = att.url;
                if (!href) return null;
                const label = att.name ?? att.filename ?? '첨부파일';
                const isImage = att.content_type?.startsWith('image/');
                if (isImage) {
                  return <AttachmentImage key={href ?? i} storedUrl={href} conversationId={message.memo_id} alt={label} />;
                }
                return (
                  <AttachmentFile
                    key={href ?? i}
                    storedUrl={href}
                    conversationId={message.memo_id}
                    label={label}
                    Icon={getFileIcon(att.content_type)}
                  />
                );
              })}
            </div>
          )}

          <time className="text-[10px] text-muted-foreground/70">{time}</time>

          {/* AC5: 답글 수 표시 — reply_count > 0 */}
          {replyCount > 0 && (
            <button
              type="button"
              onClick={handleOpenThread}
              className="mt-0.5 flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/8"
            >
              <MessageSquare className="h-3 w-3" />
              {replyCount}개의 답글
              {lastReplyTime && (
                <span className="font-normal text-muted-foreground">{lastReplyTime}</span>
              )}
            </button>
          )}
        </div>
      </div>

      {/* AC1/AC2: 컨텍스트 메뉴 */}
      {contextMenu && (
        <MessageContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          isMine={isMine}
          onReply={handleOpenThread}
          onCopy={handleCopy}
          onDelete={handleDelete}
          onClose={() => setContextMenu(null)}
        />
      )}
    </>
  );
}
