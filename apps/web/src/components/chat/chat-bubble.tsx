'use client';

import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Bot, User } from 'lucide-react';
import type { ChatMessage } from '@/hooks/use-chat-sse';
import { EntityChip, getEntityHref } from '@/components/memos/embed-card';

interface ChatBubbleProps {
  message: ChatMessage;
  isMine: boolean;
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
      <span className={`whitespace-pre-wrap break-words text-sm leading-relaxed ${text}`}>
        {content}
      </span>
    );
  }

  const prepared = hasMention ? prepareMentions(content) : content;

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      urlTransform={(url) =>
        url.startsWith('entity:') || url.startsWith('mention:') ? url : defaultUrlTransform(url)
      }
      components={{
        p: ({ children }) => <p className={`mb-1.5 break-words text-sm leading-relaxed last:mb-0 ${text}`}>{children}</p>,
        strong: ({ children }) => <strong className={`font-semibold ${text}`}>{children}</strong>,
        em: ({ children }) => <em className={`italic ${text}`}>{children}</em>,
        code: ({ children }) => <code className={`rounded px-1 py-0.5 font-mono text-xs ${codeBg}`}>{children}</code>,
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
        <div className={`rounded-2xl px-3.5 py-2 text-sm leading-relaxed break-words ${
          isMine
            ? 'rounded-tr-sm bg-primary text-primary-foreground'
            : 'rounded-tl-sm bg-muted text-foreground'
        }`}>
          <ChatMarkdown content={message.content} isMine={isMine} />
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
