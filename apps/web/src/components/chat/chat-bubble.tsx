'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { Bot, Check, Copy, MessageSquare, Terminal, User } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ChatMessage } from '@/hooks/use-chat-sse';
import { commandName, dequoteLiteral, isCommand } from '@/lib/command-classifier';
import { EmbedCard, EntityChip, getEntityHref } from '@/components/chat/embed-card';
import { parseEntityRef } from '@/components/chat/entity-ref';
import { resolveEmbedDecision } from '@/components/chat/embed-renderer';
import type { EntityStatusFetchState } from '@/components/chat/entity-status-labels';
import { AssetEmbedCard } from '@/components/chat/asset-embed-card';
import { getFileIcon } from '@/lib/file-icon';
import { AttachmentImage } from './attachment-image';
import { AttachmentMedia } from './attachment-media';
import { AttachmentFile } from './attachment-file';
import { ImageLightbox, type LightboxItem } from './image-lightbox';
import type { ReadingPanelTarget } from './reading-panel';
import { MessageContextMenu, type CiteAction } from './message-context-menu';
import { SenderProfilePopover } from './sender-profile-popover';
import { PresenceDot, WORKING_RING_CLASS, type PresenceStatus } from './presence-dot';
import { ReferenceSuggestionRow } from './reference-suggestion-row';
import { IntentSuggestionCard } from './intent-suggestion-card';
import { parseHitlRequest } from '@/lib/hitl-classifier';
import { HitlApprovalCard, type HitlAnswer } from './hitl-approval-card';
import { ApprovalRequestCard } from './approval-request-card';
import { EventBlockCard } from './event-block-card';
import { parseBlockTemplate, type EventDefinitionSummary } from '@/lib/block-template';

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
  /** story #2637 — chat-view.tsx가 대화당 1회 배치조회한 event_definitions 카탈로그(entityStatusByKey와
   * 동일 패턴). 생략하면(undefined) 이벤트 메시지도 BE 제네릭 폴백 텍스트로 안전하게 그려진다. */
  eventDefinitionsByKey?: Record<string, EventDefinitionSummary> | null;
  /** story #2766(레인 A) — ChatView가 물려주면 doc 임베드 미리보기·비-이미지 첨부 클릭이
   * 중앙 모달/새 탭 대신 우측 ReadingPanel을 연다. 생략하면(undefined, ThreadPanel 등 아직
   * 안 물려주는 호출부) 기존 동작(모달·window.open) 그대로 — 회귀 없음. */
  onOpenReadingPanel?: (target: ReadingPanelTarget) => void;
}

interface ContextMenuState {
  x: number;
  y: number;
}

// story #2671 — EmbedCard(ME-S5 원조 카드 렌더)가 실 렌더 경로에 미배선이던 것을 여기서
// 되살린다: 문단이 참조 링크 «하나뿐»(다른 텍스트 0)이면 인라인 EntityChip 대신 카드로
// 그린다 — Slack/Discord/Notion의 "단독 링크→언퍼얼 카드" 관례와 같은 자리. react-markdown
// v10은 hast-util-to-jsx-runtime에 `passNode:true`를 내부 고정해 커스텀 컴포넌트에 원본
// hast 노드를 항상 건네준다(옵션 켤 필요 없음) — 그 `node.children`(렌더된 React가 아닌
// 원본 AST)으로만 "링크 하나뿐"을 정확히 잰다(렌더된 children으로는 이미 자식 컴포넌트
// 타입이 뭉개져 있어 못 잰다).
type HastTextLike = { type?: string; value?: string; children?: HastTextLike[] };
type HastElementLike = { type?: string; tagName?: string; properties?: { href?: unknown }; children?: HastTextLike[] };

function soleLinkChild(node: HastElementLike | undefined): HastElementLike | null {
  const kids = node?.children;
  if (!kids || kids.length !== 1) return null;
  const only = kids[0] as HastElementLike;
  return only?.type === 'element' && only.tagName === 'a' ? only : null;
}

function hastNodeText(node: HastTextLike | undefined): string {
  if (!node) return '';
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(hastNodeText).join('');
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

function ChatMarkdown({ content, isMine, references, entityStatusByKey, onOpenReadingPanel }: {
  content: string; isMine: boolean; references: ChatMessage['references'];
  entityStatusByKey?: Record<string, EntityStatusFetchState>;
  onOpenReadingPanel?: (target: ReadingPanelTarget) => void;
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
    p: ({ children, node }: { children?: React.ReactNode; node?: HastElementLike }) => {
      // story #2671 — 참조 링크 하나가 문단의 전부면(다른 텍스트 0) 카드 임베드로.
      // story #2888(S2a) — 파싱은 parseEntityRef SSOT·결정은 resolveEmbedDecision(EmbedRenderer)
      // 공유. 이 슬롯은 'card' kind일 때만 반응하고(allowCard:true), asset/chip은 원래도
      // 여기선 무동작이라(기존 동작 그대로) 그대로 아래 <p> 폴백으로 떨어진다.
      const link = soleLinkChild(node);
      const href = link?.properties?.href;
      const ref = typeof href === 'string' ? parseEntityRef(href) : null;
      const decision = ref ? resolveEmbedDecision(ref.entityType, ref.entityId, references, { allowCard: true }) : null;
      if (ref && decision?.kind === 'card') {
        const statusFetch = entityStatusByKey?.[`${ref.entityType.toLowerCase()}:${ref.entityId.toLowerCase()}`];
        const status = statusFetch?.kind === 'resolved' ? statusFetch.raw : null;
        // PO 리뷰 지적 — 링크 라벨이 여러 자식(예: **강조** 섞인 텍스트)으로 쪼개질 수
        // 있어 첫 자식만 읽으면 라벨이 잘린다. 전 자식을 이어붙인다(hastNodeText가
        // 재귀로 하듯 여기도 동일 패턴).
        const label = (link!.children ?? []).map(hastNodeText).join('') || ref.entityId;
        const openReadingPanel = onOpenReadingPanel
          ? (entityType: string, entityId: string, t: string | null, s: string | null, h: string | null) =>
              onOpenReadingPanel({ kind: 'entity', entityType, entityId, title: t, status: s, href: h })
          : undefined;
        return <EmbedCard entity_type={ref.entityType} entity_id={ref.entityId} title={label} status={status} onOpenReadingPanel={openReadingPanel} />;
      }
      return <p className={`mb-1.5 [overflow-wrap:anywhere] text-sm leading-relaxed last:mb-0 ${text}`}>{children}</p>;
    },
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
      // story #2888(S2a) — 파싱·결정은 parseEntityRef+resolveEmbedDecision(EmbedRenderer) 공유.
      const ref = parseEntityRef(href);
      if (ref) {
        const decision = resolveEmbedDecision(ref.entityType, ref.entityId, references, { allowCard: false });
        // S6: 자산 토큰은 컴팩트 칩 대신 리치 임베드 카드(썸네일+메타+화살표).
        // ⛔asset은 reference_registry.ENTITY_RESOLVERS 밖의 FE 전용 타입이라(embed-card.tsx
        // 주석 참조) mention_parser가 애초에 entity_references에 안 쓴다 — stored 참조와
        // 대조하면 asset 임베드가 전부 유령으로 오판된다. 유령 판정 자체를 안 태운다.
        if (decision.kind === 'asset') {
          return <AssetEmbedCard entityId={ref.entityId} label={String(children)} ownMessage={isMine} onOpenReadingPanel={onOpenReadingPanel} />;
        }
        // allowCard:false라 decision.kind는 여기서 항상 'chip'('card'는 불가능 — resolveEmbedDecision
        // 계약: opts.allowCard가 false면 'card'를 반환하지 않는다).
        if (decision.kind === 'chip') {
          return (
            <EntityChip
              entityType={ref.entityType}
              entityId={ref.entityId}
              label={String(children)}
              href={getEntityHref(ref.entityType, ref.entityId)}
              ghost={decision.ghost}
              referenceMeta={decision.referenceMeta}
              entityStatus={entityStatusByKey?.[`${ref.entityType.toLowerCase()}:${ref.entityId.toLowerCase()}`]}
            />
          );
        }
      }
      return <a href={href} target="_blank" rel="noopener noreferrer" className={`underline underline-offset-2 ${text}`}>{children}</a>;
    },
  }), [text, muted, codeBg, border, isMine, references, entityStatusByKey, onOpenReadingPanel]);

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
  hitlAnswer = null, onRespondHitl, eventDefinitionsByKey, onOpenReadingPanel,
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
  // story #2637 AC0-a — approval_target과 동일 규율(구조화 필드 존재만으로 판별).
  const eventTarget = !isDeleted ? message.event ?? null : null;
  // story #2637 AC2/PO 리뷰(head 80319636c ①) — block_template이 실제로 파싱 가능할 때만
  // EventBlockCard로 간다. 파싱 실패/부재(정의 없음·구버전 캐시 등)는 이 상수 자체가 null이
  // 되어 아래 렌더 분기가 자연히 일반 메시지(ChatMarkdown) 경로로 흘러간다 — EventBlockCard가
  // 자체 폴백 div를 갖지 않는다(제네릭 content의 마크다운 렌더 경로까지 완전히 동일해야
  // 비회귀 — 예: "- " 리스트가 불릿으로 남아야지 하이픈 리터럴로 후퇴하면 안 된다).
  const eventBlockTemplate = eventTarget?.event_key
    ? parseBlockTemplate(eventDefinitionsByKey?.[eventTarget.event_key]?.block_template)
    : null;
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
  // story #2037 — 라이트박스. 이 메시지의 이미지 첨부에만 국한된 순번(AC3, 여러 장 넘기기는
  // 메시지 단위 스코프)을 attachments 원 배열 순서 그대로 매겨 둔다(비-이미지 첨부가 섞여
  // 있어도 이미지끼리의 상대 순서만 쓰면 되므로). react-hooks/immutability가 render 중
  // 변수 재대입을 막아 카운터를 안 쓴다 — 대신 "이 위치 앞의 이미지 개수"를 순수하게 센다
  // (한 메시지 첨부 수는 항상 소수라 O(n²)는 무관하다).
  const imageAttachmentEntries = useMemo(() => {
    const atts = message.attachments ?? [];
    const isImageAtt = (a: (typeof atts)[number]) => Boolean(a.url) && a.content_type?.startsWith('image/');
    return atts.map((att, pos) => ({
      att,
      imageIndex: isImageAtt(att) ? atts.slice(0, pos).filter(isImageAtt).length : undefined,
    }));
  }, [message.attachments]);
  const lightboxItems: LightboxItem[] = useMemo(
    () => imageAttachmentEntries
      .filter((e) => e.imageIndex !== undefined)
      .map((e) => ({ storedUrl: e.att.url!, alt: e.att.name ?? e.att.filename ?? '첨부파일' })),
    [imageAttachmentEntries],
  );
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
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
            <ApprovalRequestCard target={approvalTarget} eventDefinitionsByKey={eventDefinitionsByKey} />
          ) : eventTarget && eventBlockTemplate ? (
            <EventBlockCard
              template={eventBlockTemplate}
              payload={eventTarget.payload}
            />
          ) : hitlRequest ? (
            <HitlApprovalCard
              request={hitlRequest}
              createdAt={message.created_at}
              answer={hitlAnswer}
              onRespond={onRespondHitl!}
            />
          ) : isCmd ? (
            <div className={`min-w-0 max-w-full rounded-xl border border-info/30 bg-info/8 px-3.5 py-2 ${isMine ? 'rounded-tr-sm' : 'rounded-tl-sm'}`}>
              <div className="mb-1 flex items-center gap-1 text-[10px] font-medium text-foreground">
                <Terminal className="h-3 w-3" aria-hidden />
                {t('commandTag')}
              </div>
              <code className="block whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-sm">
                <span className="text-foreground">/{cmdName}</span>
                <span className="text-muted-foreground">{message.content.slice(1 + (cmdName?.length ?? 0))}</span>
              </code>
            </div>
          ) : (
            <div className={`min-w-0 max-w-full rounded-xl px-3.5 py-2 text-sm leading-relaxed [overflow-wrap:anywhere] ${
              isMine
                ? 'rounded-tr-sm bg-primary text-primary-foreground'
                : 'rounded-tl-sm bg-muted text-foreground'
            }`}>
              <ChatMarkdown content={displayContent} isMine={isMine} references={message.references} entityStatusByKey={entityStatusByKey} onOpenReadingPanel={onOpenReadingPanel} />
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
          {!isCmd && !isDeleted && !hitlRequest && !approvalTarget && !(eventTarget && eventBlockTemplate) && <ReferenceSuggestionRow messageId={message.id} content={message.content} isMine={isMine} projectId={projectId} />}

          {/* story #2638(P3=B1) — «승인 주시면»류 의도 문구를 말로만 쓰고 실제 기제(상신·완료
              전환·배정)를 안 거는 재발을 능동 제안으로 잡는다. ReferenceSuggestionRow와 동일
              게이트(isMine·비명령·비삭제) — 두 제안이 동시에 뜨는 것 자체는 막지 않는다(서로
              다른 축의 별개 제안이라 배타적일 이유가 없다). */}
          {!isCmd && !isDeleted && !hitlRequest && !approvalTarget && !(eventTarget && eventBlockTemplate) && (
            <IntentSuggestionCard
              messageId={message.id}
              content={message.content}
              isMine={isMine}
              entityStatusByKey={entityStatusByKey}
            />
          )}

          {/* Attachments — a54ddc16: auth-gated 서명 라우트 경유(public 직링크 미사용).
              이미지=AttachmentImage(3상태 render)·오디오/비디오=AttachmentMedia(story #2051,
              [재생] 누르기 전엔 fetch 0)·그 외=AttachmentFile(클릭 시 서명 다운로드).
              story #2319 미완 — tombstone된 메시지의 첨부는 그리지 않는다(2차 방어. 서버가
              이미 응답에서 빼고 authorize도 거부하므로 이 게이트가 빠져도 안전하지만, 화면이
              서버 계약을 스스로 어기지 않는다는 것을 명시한다). */}
          {!isDeleted && message.attachments && message.attachments.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {imageAttachmentEntries.map(({ att, imageIndex }, i) => {
                const href = att.url;
                if (!href) return null;
                const label = att.name ?? att.filename ?? '첨부파일';
                if (imageIndex !== undefined) {
                  return (
                    <AttachmentImage
                      key={href ?? i}
                      storedUrl={href}
                      conversationId={message.memo_id}
                      alt={label}
                      onOpen={() => setLightboxIndex(imageIndex)}
                    />
                  );
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
                    contentType={att.content_type}
                    assetId={att.asset_id}
                    onOpenPanel={
                      onOpenReadingPanel
                        ? (t) => onOpenReadingPanel({ kind: 'attachment', ...t })
                        : undefined
                    }
                  />
                );
              })}
            </div>
          )}

          <time className="text-[10px] text-muted-foreground">{time}</time>

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

      {/* story #2037 — 이미지 첨부 확대 뷰 */}
      {lightboxIndex !== null && (
        <ImageLightbox
          items={lightboxItems}
          startIndex={lightboxIndex}
          conversationId={message.memo_id}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </>
  );
}
