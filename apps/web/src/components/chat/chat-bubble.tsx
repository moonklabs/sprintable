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
import type { EntityStatusFetchState } from '@/components/chat/entity-status-labels';
import { AssetEmbedCard } from '@/components/chat/asset-embed-card';
import { getFileIcon } from '@/lib/file-icon';
import { AttachmentImage } from './attachment-image';
import { AttachmentMedia } from './attachment-media';
import { AttachmentFile } from './attachment-file';
import { MessageContextMenu, type CiteAction } from './message-context-menu';
import { SenderProfilePopover } from './sender-profile-popover';
import { PresenceDot, WORKING_RING_CLASS, type PresenceStatus } from './presence-dot';
import { ReferenceSuggestionRow } from './reference-suggestion-row';
import { parseHitlRequest } from '@/lib/hitl-classifier';
import { HitlApprovalCard, type HitlAnswer } from './hitl-approval-card';
import { ApprovalRequestCard } from './approval-request-card';

interface ChatBubbleProps {
  message: ChatMessage;
  isMine: boolean;
  isGrouped?: boolean;
  onOpenThread?: (message: ChatMessage) => void;
  onDelete?: (messageId: string) => void;
  /** story #2349 — 생략하면(undefined) 컨텍스트 메뉴에 「사용자 차단」 항목 자체가 안 뜬다
   * (자기 메시지엔 호출부가 안 넘긴다). 실제 차단 확認/API 호출은 호출부(ChatView) 몫 —
   * 여기는 의도만 위로 전달한다. */
  onBlockUser?: () => void;
  // 1aeecdde P2: 2축 presence — 연결(dot) + 활동(working ring). 에이전트 sender만 적용.
  presenceStatus?: PresenceStatus | null;
  isWorking?: boolean;
  // Deeplink (ade2d6d5): 딥링크 진입 시 일시 하이라이트(ring). 토큰 기반·테마 인지.
  highlight?: boolean;
  /** story #2283: 참조 후보(#번호·#슬러그) 해소 스코프. 없으면 그 확인 UI가 시도를 안 한다. */
  projectId?: string;
  /** story #2265(C-7) — 대화 인용(proof) 범위 선택 배선. 셋 다 생략하면(undefined) 기존
   * 렌더와 완전히 동일하다 — 진입점(citeAction)을 호출부가 아직 안 넘기는 한 이 기능은
   * 사용자에게 안 보인다("짓되 안 켜는다", PO 지시 2026-07-29). */
  isCiteAnchor?: boolean;
  isCiteInRange?: boolean;
  citeAction?: CiteAction;
  /** story #2262 AC2 PR② — chat-view.tsx가 배치조회한 「타입:id → 상태」 캐시(대화 전체
   * 메시지에 걸쳐 하나만 존재 — 같은 엔티티를 여러 메시지가 참조해도 fetch는 타입당 1회).
   * 생략하면(undefined) `EntityChip`이 기존처럼 `{kind:'loading'}`으로 안전 폴백한다. */
  entityStatusByKey?: Record<string, EntityStatusFetchState>;
  /** story #2572 — 이 메시지가 HITL 승인요청이고 이미 답이 관측됐으면(다른 기기 포함) 전달.
   * chat-view.tsx가 전체 messages를 훑어 계산한다(이 컴포넌트는 단일 메시지만 봄). */
  hitlAnswer?: HitlAnswer | null;
  /** story #2572 AC2 — 카드의 허용/거부 클릭이 규약 메시지(「allow」/「deny <사유>」)를 human
   * 발신으로 게시하는 기존 전송 경로(handleSend) 그대로 재사용. 생략하면(undefined) 카드
   * 자체가 안 뜬다(일반 텍스트로 폴백) — 호출부가 아직 안 넘기는 화면에서 깨진 카드가
   * 뜨지 않게 하는 안전장치. */
  onRespondHitl?: (content: string) => Promise<void>;
}

interface ContextMenuState {
  x: number;
  y: number;
}

// story #2263 AC6 — 본문 토큰(target_type+target_id)이 메시지의 stored 참조 목록에 있는지
// 대조한다. `references === undefined`(옛 서버·SSE 디스패치 등 이 필드를 안 주는 경로)는
// 판단 재료가 없다는 뜻이라 유령 처리를 보류한다(폴백 — 기존처럼 그대로 그린다). 대소문자
// 차이(사용자가 UUID를 대문자로 쳐 넣는 경우)를 흡수하려 양쪽 다 lower-case로 비교한다.
function isGhostReference(
  references: ChatMessage['references'],
  targetType: string,
  targetId: string,
): boolean {
  if (references === undefined) return false;
  const type = targetType.toLowerCase();
  const id = targetId.toLowerCase();
  return !references.some((r) => r.target_type.toLowerCase() === type && r.target_id.toLowerCase() === id);
}

// story #2262 AC1(2026-08-08) — doc `flow-map-blueprint-v1` §2-3 「사실성 · 표면 · 지점」의
// «표면·지점» 재료. isGhostReference와 같은 대조를 한 번 더 해 form·referenced_at까지
// 끌어온다(스토리 자신의 AC1 정의: 표면=form('mention'|'embed'|'proof'), 지점=referenced_at —
// "이 참조가 «언제 생겼나»"이지 대상이 「언제 만들어졌나」가 아니다). 매칭 없으면(유령이거나
// references 자체가 없으면) null — 그때는 칩에 표기하지 않는다(모르는 것을 지어내지 않는다).
function findReferenceMeta(
  references: ChatMessage['references'],
  targetType: string,
  targetId: string,
): { form: string; referencedAt: string } | null {
  if (!references) return null;
  const type = targetType.toLowerCase();
  const id = targetId.toLowerCase();
  const match = references.find((r) => r.target_type.toLowerCase() === type && r.target_id.toLowerCase() === id);
  if (!match || !match.form || !match.referenced_at) return null;
  return { form: match.form, referencedAt: match.referenced_at };
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

function ChatMarkdown({ content, isMine, references, entityStatusByKey }: {
  content: string; isMine: boolean; references: ChatMessage['references'];
  entityStatusByKey?: Record<string, EntityStatusFetchState>;
}) {
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
    // story #2165: 코드블럭은 전역 스크롤바 숨김 예외 — 가로로 잘린 줄이 있다는 것을 알려야 한다.
    pre: ({ children }: { children?: React.ReactNode }) => <pre className={`mb-1.5 overflow-x-auto scrollbar-visible rounded-lg p-2.5 text-xs ${codeBg}`}>{children}</pre>,
    // story #2035 AC2 — 표는 자기 컨테이너 안에서만 가로 스크롤(doc-content-renderer.tsx의
    // 검증된 not-prose overflow-x-auto 패턴 재사용). whitespace-nowrap 없으면 브라우저가
    // 열 텍스트를 좁은 말풍선 폭에 맞춰 줄바꿈/축약해버려 "열 삭제·축약 금지" 위반이 됨 —
    // nowrap으로 열 폭을 원문 그대로 유지하고 넘치는 만큼 래퍼가 스크롤하게 한다.
    // story #2165: 표도 코드블럭과 같은 성격 — 스크롤바 숨김 예외.
    table: ({ children }: { children?: React.ReactNode }) => (
      <div className={`mb-1.5 overflow-x-auto scrollbar-visible rounded-lg border ${border}`}>
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
        // ⛔asset은 reference_registry.ENTITY_RESOLVERS 밖의 FE 전용 타입이라(embed-card.tsx
        // 주석 참조) mention_parser가 애초에 entity_references에 안 쓴다 — stored 참조와
        // 대조하면 asset 임베드가 전부 유령으로 오판된다. 유령 판정 자체를 안 태운다.
        if (m[1]!.toLowerCase() === 'asset') {
          return <AssetEmbedCard entityId={m[2]!} label={String(children)} ownMessage={isMine} />;
        }
        const ghost = isGhostReference(references, m[1]!, m[2]!);
        const referenceMeta = ghost ? null : findReferenceMeta(references, m[1]!, m[2]!);
        return (
          <EntityChip
            entityType={m[1]!}
            entityId={m[2]!}
            label={String(children)}
            href={getEntityHref(m[1]!, m[2]!)}
            ghost={ghost}
            referenceMeta={referenceMeta}
            entityStatus={entityStatusByKey?.[`${m[1]!.toLowerCase()}:${m[2]!.toLowerCase()}`]}
          />
        );
      }
      return <a href={href} target="_blank" rel="noopener noreferrer" className={`underline underline-offset-2 ${text}`}>{children}</a>;
    },
  }), [text, muted, codeBg, border, isMine, references, entityStatusByKey]);

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

export function ChatBubble({
  message, isMine, isGrouped = false, onOpenThread, onDelete, onBlockUser, presenceStatus, isWorking = false,
  highlight = false, projectId, isCiteAnchor = false, isCiteInRange = false, citeAction, entityStatusByKey,
  hitlAnswer = null, onRespondHitl,
}: ChatBubbleProps) {
  const t = useTranslations('chats');
  const isAgent = message.sender_type === 'agent';
  // story #2319 — tombstone. content는 서버가 이미 ""로 스크럽했다(오발송 대응 목적).
  const isDeleted = Boolean(message.deleted_at);
  // story #2572 — sniffing 조건: 에이전트 발신(사람이 같은 텍스트를 쳐도 카드화 금지, PO 가드①)
  // + 플러그인 고정 포맷 정확 매칭(패턴이 안 맞으면 null → 일반 텍스트 폴백, PO 가드②)
  // + 응답 핸들러가 실제로 있을 때만(없는 화면=스레드 패널 등에서 깨진 카드 방지).
  const hitlRequest = !isDeleted && isAgent && onRespondHitl ? parseHitlRequest(message.content) : null;
  // story #2604 P2 — BE가 실은 approval_target(additive)이 있으면 카드로 렌더. hitlRequest와
  // 달리 sniffing(정규식 매칭) 없이 구조화 필드 존재만으로 판별 — BE가 이미 결정한 사실이라
  // FE가 다시 추측할 이유가 없다.
  const approvalTarget = !isDeleted ? message.approval_target ?? null : null;
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
  // story #2349 — "상대 프로필" 진입점(자기 자신엔 없다, isMine 게이트).
  const [profilePopover, setProfilePopover] = useState<ContextMenuState | null>(null);
  const handleOpenProfilePopover = useCallback((e: { currentTarget: Element }) => {
    if (isMine) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setProfilePopover({ x: rect.left, y: rect.bottom + 4 });
  }, [isMine]);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchPosRef = useRef<{ x: number; y: number } | null>(null);
  // story #2349 — tombstone(deleted_at)과 다르다: 서버는 내용을 그대로 내려주고, 가리는 것은
  // 클라 몫이다("보기"로 펼칠 수 있어야 한다 — PO 규격). 기본은 가린 상태.
  const [blockedMessageRevealed, setBlockedMessageRevealed] = useState(false);
  const isBlockedSender = message.is_blocked_sender === true;

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
        className={`flex scroll-mt-4 gap-2 transition-shadow ${isMine ? 'flex-row-reverse' : 'flex-row'} ${isGrouped ? 'mt-0.5' : 'mt-2'} ${highlight ? 'rounded-lg ring-2 ring-primary ring-offset-2 ring-offset-background' : ''} ${(isCiteAnchor || isCiteInRange) ? 'border-l-[3px] border-l-primary pl-1' : ''}`}
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
            {/* story #2349 — "상대 프로필" 진입점. 자기 자신 아바타는 클릭 불가(role/tabIndex도 안 붙임). */}
            <div
              role={isMine ? undefined : 'button'}
              tabIndex={isMine ? undefined : 0}
              onClick={isMine ? undefined : handleOpenProfilePopover}
              onKeyDown={isMine ? undefined : (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleOpenProfilePopover(e); } }}
              className={`flex h-full w-full items-center justify-center rounded-full text-xs font-medium ${
                isAgent
                  ? 'bg-accent-claim/15 text-accent-claim'
                  : isMine
                    ? 'bg-primary/20 text-primary'
                    : 'bg-muted text-muted-foreground'
              } ${isAgent && isWorking ? WORKING_RING_CLASS : ''} ${isMine ? '' : 'cursor-pointer'}`}
            >
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
              <span
                role={isMine ? undefined : 'button'}
                tabIndex={isMine ? undefined : 0}
                onClick={isMine ? undefined : handleOpenProfilePopover}
                onKeyDown={isMine ? undefined : (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleOpenProfilePopover(e); } }}
                className={`text-[11px] font-medium text-muted-foreground ${isMine ? '' : 'cursor-pointer hover:underline'}`}
              >
                {displayName}
              </span>
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
          {isDeleted ? (
            // story #2319 — tombstone placeholder. 색/경고 없이 무채색(story #2299 AC⑤와 같은
            // 규율 — 「끊어짐」은 사실 표시일 뿐 에러가 아니다).
            <div className={`min-w-0 max-w-full rounded-xl px-3.5 py-2 text-sm italic text-muted-foreground ${
              isMine ? 'rounded-tr-sm bg-muted/50' : 'rounded-tl-sm bg-muted/50'
            }`}>
              {t('deletedMessagePlaceholder')}
            </div>
          ) : isBlockedSender && !blockedMessageRevealed ? (
            // story #2349 — tombstone과 다르다: 서버는 내용을 그대로 내려준다. 여기서 클라가
            // 가리고, "보기"로 펼칠 수 있어야 한다(PO 규격 — 되돌릴 수 없는 tombstone과 구분).
            <div className={`min-w-0 max-w-full rounded-xl px-3.5 py-2 text-sm italic text-muted-foreground ${
              isMine ? 'rounded-tr-sm bg-muted/50' : 'rounded-tl-sm bg-muted/50'
            }`}>
              {t('blockedSenderMessagePlaceholder')}{' '}
              <button
                type="button"
                onClick={() => setBlockedMessageRevealed(true)}
                className="not-italic underline underline-offset-2 hover:text-foreground"
              >
                {t('blockedSenderMessageReveal')}
              </button>
            </div>
          ) : approvalTarget ? (
            <ApprovalRequestCard target={approvalTarget} />
          ) : hitlRequest ? (
            <HitlApprovalCard
              request={hitlRequest}
              createdAt={message.created_at}
              answer={hitlAnswer}
              onRespond={onRespondHitl!}
            />
          ) : isCmd ? (
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
              <ChatMarkdown content={displayContent} isMine={isMine} references={message.references} entityStatusByKey={entityStatusByKey} />
            </div>
          )}

          {/* story #2349(유나 design:changes) — "보기"로 펼친 뒤 되돌릴 문턱이 없으면
              "이걸 누르면 계속 보이나?"가 걸려 아예 안 누르게 된다(가리기+확認 가능을 둘 다
              주려던 설계가 반만 서는 것). 되돌릴 수 있어야 눌러 볼 수 있다. */}
          {!isDeleted && isBlockedSender && blockedMessageRevealed && (
            <button
              type="button"
              onClick={() => setBlockedMessageRevealed(false)}
              className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              {t('blockedSenderMessageHide')}
            </button>
          )}

          {/* story #2283 — 보낸 직후 그 메시지 바로 아래에서 한 번 제안(작성자 본인에게만,
              isMine 게이트는 컴포넌트 내부에서 건다). ⛔남의 메시지엔 안 뜬다. tombstone된
              메시지엔 제안할 실 내용이 없다(story #2319). */}
          {!isCmd && !isDeleted && !hitlRequest && !approvalTarget && <ReferenceSuggestionRow messageId={message.id} content={message.content} isMine={isMine} projectId={projectId} />}

          {/* Attachments — a54ddc16: auth-gated 서명 라우트 경유(public 직링크 미사용).
              이미지=AttachmentImage(3상태 render)·오디오/비디오=AttachmentMedia(story #2051,
              [재생] 누르기 전엔 fetch 0)·그 외=AttachmentFile(클릭 시 서명 다운로드).
              story #2319 미완 — tombstone된 메시지의 첨부는 그리지 않는다(2차 방어. 서버가
              이미 응답에서 빼고 authorize도 거부하므로 이 게이트가 빠져도 안전하지만, 화면이
              서버 계약을 스스로 어기지 않는다는 것을 명시한다). */}
          {!isDeleted && message.attachments && message.attachments.length > 0 && (
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
          citeAction={citeAction}
          isDeleted={isDeleted}
          onBlock={onBlockUser}
        />
      )}

      {/* story #2349 — "상대 프로필" 진입점 */}
      {profilePopover && (
        <SenderProfilePopover
          x={profilePopover.x}
          y={profilePopover.y}
          name={displayName}
          isAgent={isAgent}
          onClose={() => setProfilePopover(null)}
          onBlock={onBlockUser}
        />
      )}
    </>
  );
}
