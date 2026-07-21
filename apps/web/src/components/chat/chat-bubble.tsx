'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { Bot, Check, Copy, MessageSquare, Terminal, User } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ChatMessage } from '@/hooks/use-chat-sse';
import { commandName, dequoteLiteral, isCommand } from '@/lib/command-classifier';
import { EntityChip, getEntityHref } from '@/components/chat/embed-card';
import { AssetEmbedCard } from '@/components/chat/asset-embed-card';
import { getFileIcon } from '@/lib/file-icon';
import { AttachmentImage } from './attachment-image';
import { AttachmentMedia } from './attachment-media';
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
  // Deeplink (ade2d6d5): 딥링크 진입 시 일시 하이라이트(ring). 토큰 기반·테마 인지.
  highlight?: boolean;
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

// story #2002: 원클릭 복사 — inline(단일 백틱)은 클릭 즉시 복사, 블록(펜스)은 호버 시 드러나는
// 코너 버튼. inline/block 판별은 doc-content-renderer.tsx의 기존 검증된 휴리스틱과 동일
// (className에 language- 없음 + 개행 없음 = inline) — 팀 컨벤션 재사용.
function CopyableCode({ raw, inline, className }: { raw: string; inline: boolean; className: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    void (async () => {
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(raw);
        } else {
          return;
        }
      } catch {
        return; // 클립보드 권한거부/미지원 — 조용히 무시(피드백 미표시로 실패가 드러남)
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    })();
  }, [raw]);

  if (inline) {
    return (
      <code
        role="button"
        tabIndex={0}
        onClick={handleCopy}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleCopy(); } }}
        title={copied ? '복사됨' : '클릭해 복사'}
        className={`${className} cursor-pointer transition hover:brightness-95 active:brightness-90`}
      >
        {raw}
        {copied && <Check className="ml-0.5 inline size-3 align-text-top" aria-hidden />}
      </code>
    );
  }

  return (
    <span className="group/code relative block">
      <code className={className}>{raw}</code>
      <button
        type="button"
        onClick={handleCopy}
        aria-label={copied ? '복사됨' : '코드 복사'}
        title={copied ? '복사됨' : '코드 복사'}
        className="absolute right-1 top-1 rounded p-1 opacity-60 transition hover:bg-black/10 group-hover/code:opacity-100 dark:hover:bg-white/10"
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
    </span>
  );
}

function ChatMarkdown({ content, isMine }: { content: string; isMine: boolean }) {
  const text = isMine ? 'text-primary-foreground' : 'text-foreground';
  const muted = isMine ? 'text-primary-foreground/70' : 'text-muted-foreground';
  const codeBg = isMine ? 'bg-primary-foreground/10 text-primary-foreground' : 'bg-muted text-foreground';
  const border = isMine ? 'border-primary-foreground/30' : 'border-border';

  const hasMention = /@[\w가-힣]+/.test(content);
  const hasMarkdown = /[*_`#\[\]>~]|entity:/.test(content);

  // story #2021: react-markdown이 리졸브한 컴포넌트 함수 참조를 그대로 React 엘리먼트 type으로
  // 쓴다(hast-util-to-jsx-runtime `state.components[name]`). 이 객체를 매 렌더 인라인으로 새로
  // 만들면 `a`(엔티티 칩/미리보기 모달 포함)·`code`(CopyableCode) 서브트리가 타입 불일치로
  // 매번 언마운트→리마운트된다 — 무관한 부모 리렌더(presence 폴링 등)마다 열려 있던 문서
  // 미리보기 모달의 로컬 state(showModal)가 통째로 날아가 닫히던 근본 원인. isMine이 안 바뀌는
  // 한 참조를 고정해 react-markdown이 같은 컴포넌트 인스턴스를 재사용하게 한다. hasMarkdown이
  // false인 이른 return보다 위에 둬 훅 호출 순서를 무조건화한다(rules-of-hooks).
  const components = useMemo(() => ({
    p: ({ children }: { children?: React.ReactNode }) => <p className={`mb-1.5 [overflow-wrap:anywhere] text-sm leading-relaxed last:mb-0 ${text}`}>{children}</p>,
    strong: ({ children }: { children?: React.ReactNode }) => <strong className={`font-semibold ${text}`}>{children}</strong>,
    em: ({ children }: { children?: React.ReactNode }) => <em className={`italic ${text}`}>{children}</em>,
    code: ({ className, children }: { className?: string; children?: React.ReactNode }) => {
      const raw = String(children).replace(/\n$/, '');
      const inline = !className?.includes('language-') && !raw.includes('\n');
      return (
        <CopyableCode
          raw={raw}
          inline={inline}
          className={`rounded px-1 py-0.5 font-mono text-xs [overflow-wrap:anywhere] ${codeBg}`}
        />
      );
    },
    pre: ({ children }: { children?: React.ReactNode }) => <pre className={`mb-1.5 overflow-x-auto rounded-lg p-2.5 text-xs ${codeBg}`}>{children}</pre>,
    // story #2035 AC2 — 표는 자기 컨테이너 안에서만 가로 스크롤(doc-content-renderer.tsx의
    // 검증된 not-prose overflow-x-auto 패턴 재사용). whitespace-nowrap 없으면 브라우저가
    // 열 텍스트를 좁은 말풍선 폭에 맞춰 줄바꿈/축약해버려 "열 삭제·축약 금지" 위반이 됨 —
    // nowrap으로 열 폭을 원문 그대로 유지하고 넘치는 만큼 래퍼가 스크롤하게 한다.
    table: ({ children }: { children?: React.ReactNode }) => (
      <div className={`mb-1.5 overflow-x-auto rounded-lg border ${border}`}>
        <table className="whitespace-nowrap text-xs">{children}</table>
      </div>
    ),
    thead: ({ children }: { children?: React.ReactNode }) => <thead className={muted}>{children}</thead>,
    th: ({ children }: { children?: React.ReactNode }) => <th className={`border-b px-2 py-1 text-left font-semibold ${border} ${text}`}>{children}</th>,
    td: ({ children }: { children?: React.ReactNode }) => <td className={`border-b px-2 py-1 ${border} ${text}`}>{children}</td>,
    ul: ({ children }: { children?: React.ReactNode }) => <ul className={`mb-1.5 ml-4 list-disc space-y-0.5 text-sm ${text}`}>{children}</ul>,
    ol: ({ children }: { children?: React.ReactNode }) => <ol className={`mb-1.5 ml-4 list-decimal space-y-0.5 text-sm ${text}`}>{children}</ol>,
    li: ({ children }: { children?: React.ReactNode }) => <li className={`text-sm leading-relaxed ${text}`}>{children}</li>,
    blockquote: ({ children }: { children?: React.ReactNode }) => <blockquote className={`mb-1.5 border-l-2 pl-3 ${border} ${muted}`}>{children}</blockquote>,
    a: ({ href, children }: { href?: string; children?: React.ReactNode }) => {
      if (href?.startsWith('mention:')) {
        return (
          <span className={`font-medium ${isMine ? 'text-primary-foreground underline decoration-primary-foreground/40' : 'text-primary'}`}>
            {children}
          </span>
        );
      }
      // id 는 UUID 만 허용 — `dead`·`----` 등 비-UUID는 매칭 실패→평문 링크로 폴백(엔티티 칩/카드 미렌더).
      const m = href?.match(/^entity:(\w+):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
      if (m) {
        // S6: 자산 토큰은 컴팩트 칩 대신 리치 임베드 카드(썸네일+메타+화살표).
        if (m[1]!.toLowerCase() === 'asset') {
          return <AssetEmbedCard entityId={m[2]!} label={String(children)} ownMessage={isMine} />;
        }
        return <EntityChip entityType={m[1]!} entityId={m[2]!} label={String(children)} href={getEntityHref(m[1]!, m[2]!)} />;
      }
      return <a href={href} target="_blank" rel="noopener noreferrer" className={`underline underline-offset-2 ${text}`}>{children}</a>;
    },
  }), [text, muted, codeBg, border, isMine]);

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
      components={components}
    >
      {prepared}
    </ReactMarkdown>
  );
}

const LONG_PRESS_MS = 500;

export function ChatBubble({ message, isMine, isGrouped = false, onOpenThread, onDelete, presenceStatus, isWorking = false, highlight = false }: ChatBubbleProps) {
  const t = useTranslations('chats');
  const isAgent = message.sender_type === 'agent';
  // S8: 슬래시 커맨드는 전용 버블(brand·mono·⌘). 리터럴(`//`)은 dequote된 일반 텍스트.
  const isCmd = isCommand(message.content);
  const isLiteral = !isCmd && message.content.startsWith('//');
  const displayContent = isLiteral ? dequoteLiteral(message.content) : message.content;
  const cmdName = isCmd ? commandName(message.content) : null;
  const displayName = isMine ? t('you') : (message.sender_name || t('team'));
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
        id={`msg-${message.id}`}
        className={`flex scroll-mt-4 gap-2 transition-shadow ${isMine ? 'flex-row-reverse' : 'flex-row'} ${isGrouped ? 'mt-0.5' : 'mt-2'} ${highlight ? 'rounded-lg ring-2 ring-primary ring-offset-2 ring-offset-background' : ''}`}
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

          {/* Content — S8: command 전용 버블(brand·mono·⌘ 태그) vs 일반(리터럴은 dequote 표시).
              story #2035: min-w-0+max-w-full — 부모 컬럼(min-w-0 max-w-[72%] items-start/end)이
              flex-item 자식을 cross-axis에서 stretch가 아닌 shrink-to-fit으로 배치하므로, 이
              말풍선 배경 div 자체에 상한이 없으면 표·코드블록의 min-content가 부모 max-w를
              무시하고 새어나간다(재현·측정 확認 — 아래 근거 참고). max-w-full로 컬럼의 269px
              상한을 이 자식에도 강제해야 안의 pre(overflow-x-auto)·표(overflow-x-auto 래퍼)가
              비로소 자기 박스 안에서 스크롤된다. */}
          {isCmd ? (
            <div className={`min-w-0 max-w-full rounded-xl border border-info/30 bg-info/8 px-3.5 py-2 ${isMine ? 'rounded-tr-sm' : 'rounded-tl-sm'}`}>
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
            <div className={`min-w-0 max-w-full rounded-xl px-3.5 py-2 text-sm leading-relaxed [overflow-wrap:anywhere] ${
              isMine
                ? 'rounded-tr-sm bg-primary text-primary-foreground'
                : 'rounded-tl-sm bg-muted text-foreground'
            }`}>
              <ChatMarkdown content={displayContent} isMine={isMine} />
            </div>
          )}

          {/* Attachments — a54ddc16: auth-gated 서명 라우트 경유(public 직링크 미사용).
              이미지=AttachmentImage(3상태 render)·오디오/비디오=AttachmentMedia(story #2051,
              [재생] 누르기 전엔 fetch 0)·그 외=AttachmentFile(클릭 시 서명 다운로드). */}
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
                const isAudio = att.content_type?.startsWith('audio/');
                const isVideo = att.content_type?.startsWith('video/');
                if (isAudio || isVideo) {
                  return (
                    <AttachmentMedia
                      key={href ?? i}
                      storedUrl={href}
                      conversationId={message.memo_id}
                      label={label}
                      kind={isAudio ? 'audio' : 'video'}
                    />
                  );
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
