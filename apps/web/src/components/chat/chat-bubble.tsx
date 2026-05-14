'use client';

import type { ChatMessage } from '@/hooks/use-chat-sse';

interface ChatBubbleProps {
  message: ChatMessage;
  isMine: boolean;
}

export function ChatBubble({ message, isMine }: ChatBubbleProps) {
  const time = new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit' }).format(new Date(message.created_at));

  return (
    <div className={`flex gap-2 ${isMine ? 'flex-row-reverse' : 'flex-row'}`}>
      {/* Avatar */}
      <div className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-xs font-medium ${
        isMine
          ? 'bg-primary/20 text-primary'
          : 'bg-muted text-muted-foreground'
      }`}>
        {isMine ? '나' : '팀'}
      </div>

      {/* Bubble + meta */}
      <div className={`flex max-w-[72%] flex-col gap-1 ${isMine ? 'items-end' : 'items-start'}`}>
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
