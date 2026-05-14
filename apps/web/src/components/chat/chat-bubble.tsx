'use client';

import { Bot, User } from 'lucide-react';
import type { ChatMessage } from '@/hooks/use-chat-sse';

interface ChatBubbleProps {
  message: ChatMessage;
  isMine: boolean;
}

export function ChatBubble({ message, isMine }: ChatBubbleProps) {
  const isAgent = message.sender_type === 'agent';
  const displayName = isMine ? '나' : (message.sender_name || '팀');
  const time = new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit' }).format(new Date(message.created_at));

  return (
    <div className={`flex gap-2 ${isMine ? 'flex-row-reverse' : 'flex-row'}`}>
      {/* Avatar */}
      <div className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-xs font-medium ${
        isAgent
          ? 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300'
          : isMine
            ? 'bg-primary/20 text-primary'
            : 'bg-muted text-muted-foreground'
      }`}>
        {isAgent ? <Bot className="h-3.5 w-3.5" /> : <User className="h-3.5 w-3.5" />}
      </div>

      {/* Bubble + meta */}
      <div className={`flex max-w-[72%] flex-col gap-1 ${isMine ? 'items-end' : 'items-start'}`}>
        {/* Sender name */}
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] font-medium text-muted-foreground">{displayName}</span>
          {isAgent && (
            <span className="rounded-sm bg-violet-100 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">
              AI
            </span>
          )}
        </div>

        {/* Content */}
        <div className={`rounded-2xl px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words ${
          isMine
            ? 'rounded-tr-sm bg-primary text-primary-foreground'
            : 'rounded-tl-sm bg-muted text-foreground'
        }`}>
          {message.content}
        </div>

        {/* Attachments */}
        {message.attachments && message.attachments.length > 0 && (
          <div className="flex flex-col gap-1.5">
            {message.attachments.map((att, i) => {
              const href = att.url;
              const label = att.name ?? att.filename ?? '첨부파일';
              const isImage = att.content_type?.startsWith('image/');
              return (
                <a
                  key={href ?? i}
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-xs hover:bg-muted/50"
                >
                  {isImage && href ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img src={href} alt={label} className="max-h-40 max-w-[240px] rounded object-contain" />
                  ) : (
                    <span className="truncate text-muted-foreground">{label}</span>
                  )}
                </a>
              );
            })}
          </div>
        )}

        <time className="text-[10px] text-muted-foreground/70">{time}</time>
      </div>
    </div>
  );
}
