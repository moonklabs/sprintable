'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, RefreshCw, WifiOff, UserX } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { resolveDisplayTimezone } from '@/components/content/schedule-format';
import { ChatBubble } from './chat-bubble';
import type { PresenceStatus } from './presence-dot';
import { CommandHintNotice, type BlockedHint } from './command-hint-notice';
import { ReferenceDropNotice, parseDroppedReferences, type DroppedReference } from './reference-drop-notice';
import { ChatInput, type CommandTarget } from './chat-input';
import { ThreadPanel } from './thread-panel';
import { ReadingPanel, type ReadingPanelTarget } from './reading-panel';
import { useReadingPanelStack } from './use-reading-panel-stack';
import { ReadingPanelProvider } from './reading-panel-context';
import type { ChatMessage, SendAttachment } from '@/hooks/use-chat-sse';
import { useIsMobile } from '@/hooks/use-mobile';
import { normalizeToMessage, useChatSse, type SseWorkingPayload } from '@/hooks/use-chat-sse';
import { isHitlReply, parseHitlRequest } from '@/lib/hitl-classifier';
import type { HitlAnswer } from './hitl-approval-card';
import type { EntityStatusFetchState } from '@/components/chat/entity-status-labels';
import { useEntityStatusBatchFetch } from '@/hooks/use-entity-status-batch';
import { useGateBatchFetch } from '@/hooks/use-gate-batch';
import type { CardState as GateCardState } from '@/components/chat/approval-request-card';
import type { EventDefinitionSummary } from '@/lib/block-template';
import { useMessageRangeSelection } from '@/hooks/use-message-range-selection';
import { CitationComposeBar, type CitationSaveState } from './citation-compose-bar';
import { StoryPickerDialog } from '@/components/canvas/story-picker-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { ToastContainer, useToast } from '@/components/ui/toast';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { fetchWithAuth } from '@/lib/db/client';
import { useChatRail } from '@/app/(authenticated)/chats/chat-rail-context';

interface ChatViewProps {
  threadId: string;
  currentTeamMemberId: string;
  projectId?: string;
  apiPrefix?: string;
  // story #2032 AC4: ESC로 나갈 목적지. router.replace()로 이동한다(router.back()/
  // window.history.back() 직접호출 금지 — [[feedback-history-back-nextjs]] 하우스룰,
  // #2266이 이미 이 페이지의 헤더 백버튼에 적용한 것과 동일 패턴).
  backHref?: string;
  // S8 #2: pre-send capability 경고 대상(에이전트 participant runtime). 빈 배열이면 경고 미표시(graceful).
  commandTargets?: CommandTarget[];
  // 1aeecdde P2: 에이전트 member_id → presence_status(연결축 dot). 없으면 dot 미표시(graceful).
  presenceById?: Record<string, PresenceStatus>;
  // Deeplink (ade2d6d5): 진입 시 스크롤+하이라이트할 메시지 id(?messageId=). 없으면 일반 동작(하단 스크롤).
  scrollToMessageId?: string;
  // story #1977(트랙B): #1976 read state 계약(last_read_at)의 caller 값. undefined=아직 로드
  // 전(meta fetch 레이스, "여기부터 안읽음" 마커 계산을 그 값 도착까지 보류) · null=한 번도 안
  // 읽음(모든 타인 메시지 앞에 마커) · string=그 시각 이후 타인 메시지 앞에 마커.
  initialLastReadAt?: string | null;
  // story #2942(2921-S5) — composer STEER 모드의 대상 피커. 대화 참가자로 한정해야
  // (doc steer-event-axis-design-2927 §4) POST /events/publish의 conversation_id 오버라이드
  // fail-closed(§2 보강, 422 conversation_target_mismatch)를 애초에 안 만난다. 없으면(구
  // 호출부·비-2942 화면) STEER 토글 자체를 숨긴다(graceful — 신규 표면 0 강제 아님).
  // story #3194 — type/verified 추가(둘 다 optional·graceful). verified는 agent_verify.py::
  // get_verified_map()과 같은 정의(#2751 설계②가 워크포스 "연결 안 됨" 배지에 쓰는 그 판별자,
  // 발명 0) — false=stdio verify 미완주. undefined/null/human이면 미연결 배너 미표시.
  participants?: { member_id: string; name: string | null; type?: string; verified?: boolean | null }[];
}

interface MessageGroup {
  date: string;
  messages: ChatMessage[];
}

// Deeplink (ade2d6d5): scroll-to-message가 대상 탐색을 위해 이전 페이지를 로드하는 최대 횟수(런어웨이 방지).
// 50/page × 10 = ~500개. 그 안에 없으면 no-op(graceful).
const MAX_SCROLL_LOAD_ATTEMPTS = 10;

// story #3493 — 날짜 구분선(day divider)은 "기록"도 "약속"도 아니다(개별 시각이 decay하는
// 값이 아니라, 그 날 하루 전체를 대표하는 고정 달력 라벨 — formatRelativeTime을 쓰면 그룹
// 헤더가 시간이 지나며 "3일 전"으로 계속 바뀌어 구분선 목적과 어긋나고, formatScheduledAt은
// 시각·TZ 접미사가 붙어 날짜 전용 헤더에 맞지 않는다). schedule-format.ts의 toDateKey와
// 같은 방식(Intl.DateTimeFormat 직접 호출 — 새 포맷 함수 신설 아님, 기존 정본과 동형 패턴)
// 으로 하드코딩 'ko-KR'만 실제 locale로 교정한다. PR 분류표에 "기록/약속 밖(날짜 구분선)"으로
// 별도 표기.
function groupByDate(messages: ChatMessage[], locale: string, displayTimezone: string): MessageGroup[] {
  const groups: Record<string, ChatMessage[]> = {};
  const dateFmt = new Intl.DateTimeFormat(locale, {
    year: 'numeric', month: 'long', day: 'numeric', timeZone: displayTimezone,
  });
  for (const msg of messages) {
    const date = dateFmt.format(new Date(msg.created_at));
    (groups[date] ??= []).push(msg);
  }
  return Object.entries(groups).map(([date, msgs]) => ({ date, messages: msgs }));
}

// story #3081(정본 ⑤) — 재연결·focus 재조회(before 없는 fetchMessages 호출)가 서버 최신
// 50개로 통째로 setMessages(data)하면 사용자가 위로 스크롤해 loadMore로 펼쳐 둔 과거
// 페이지가 날아간다. data[0](가장 오래된 신규 항목)보다 더 과거인 prev 항목만 보존해
// 앞에 붙인다 — dedup은 id로(data와 겹치는 구간은 새 값을 신뢰).
export function mergeBackfilledMessages(prev: ChatMessage[], data: ChatMessage[]): ChatMessage[] {
  if (!data.length) return prev;
  const newIds = new Set(data.map((m) => m.id));
  const olderKept = prev.filter((m) => !newIds.has(m.id) && m.created_at < data[0]!.created_at);
  return [...olderKept, ...data];
}

// story #3081(정본 ③) — backfill(fetchMessages 재조회)이 채운 신규 메시지도 addMessage(SSE
// 실시간 수신)와 동일하게 「활성 뷰어가 하단을 보고 있으면 mark-read」돼야 한다. 표시할
// up_to 시각을 판정만 순수함수로 뽑는다(호출 자체는 handleReconnect가 한다).
export function resolveBackfillMarkReadIso(latest: ChatMessage[] | undefined, nearBottom: boolean): string | null {
  if (!latest?.length || !nearBottom) return null;
  return latest[latest.length - 1]!.created_at;
}

// story #3194 — 미연결 에이전트 참가자(본인 제외) 판별을 순수함수로 뽑아 직접 단위테스트
// 가능하게 한다(mergeBackfilledMessages/resolveBackfillMarkReadIso와 동형 관례). verified
// ===false만 대상(undefined/null=판별 불가라 배너 미표시 — agent-management-tab.tsx와 동일
// 안전 방향, 침묵 실패보다 과소표시가 낫다). 판정 자체는 #2751 get_verified_map 그대로(발명
// 0) — 이 함수는 그 결과를 소비만 한다.
export function filterUnconnectedAgentParticipants(
  participants: { member_id: string; name: string | null; type?: string; verified?: boolean | null }[] | undefined,
  currentTeamMemberId: string,
): { member_id: string; name: string | null; type?: string; verified?: boolean | null }[] {
  return (participants ?? []).filter(
    (p) => p.member_id !== currentTeamMemberId && p.type === 'agent' && p.verified === false,
  );
}

export function ChatView({ threadId, currentTeamMemberId, projectId, apiPrefix = '/api/chats', backHref = '/chats', commandTargets, presenceById, scrollToMessageId, initialLastReadAt, participants }: ChatViewProps) {
  const router = useRouter();
  const pathname = usePathname();
  const t = useTranslations('chats');
  const locale = useLocale();
  const displayTimezone = resolveDisplayTimezone().tz;
  // story #3194 — 'agents' 네임스페이스의 viewConnectionSettings 키를 그대로 재사용(발명 0,
  // agent-management-tab.tsx의 동일 CTA와 문구 일치).
  const ta = useTranslations('agents');
  const isMobile = useIsMobile();
  const { toasts, addToast, dismissToast } = useToast();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // story #2265(C-7) 저장 조각(2026-07-29) — write 엔드포인트(#2632)가 서서 citeAction을
  // 실제로 켠다. 선택 확定(confirming) 후 스토리 피커를 열어 골라진 스토리에 저장한다.
  const citeSelection = useMessageRangeSelection();
  const orderedMessageIds = useMemo(() => messages.map((m) => m.id), [messages]);
  const [citationPickerOpen, setCitationPickerOpen] = useState(false);
  const [citationSaveState, setCitationSaveState] = useState<CitationSaveState>('idle');
  // story #92f00dc4(doc exec-command-final-spec-92f00dc4 §🎯) — 서버 집행 커맨드 결과 카드의
  // 「모호」 후보 클릭 = 입력창을 해소된 명령으로 채움(즉시 집행 아님). nonce는 같은 텍스트를
  // 두 번 연속 눌러도 ChatInput의 effect가 반응하도록 매 클릭마다 증가시키는 카운터.
  const [prefillCommand, setPrefillCommand] = useState<{ text: string; nonce: number } | null>(null);
  const handleFillComposer = useCallback((text: string) => {
    setPrefillCommand((prev) => ({ text, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [showNewIndicator, setShowNewIndicator] = useState(false);
  // S5: 미지원 런타임 커맨드 차단 hint — 트리거 메시지 id에 keyed된 ephemeral state.
  // POST 응답 command_gate.blocked에서만 적재(persist 안 함·reload 시 소멸).
  const [commandHints, setCommandHints] = useState<Record<string, BlockedHint[]>>({});
  // story #2294 AC8 — 낙관적으로 링크만 그리고 저장 결과를 안 보던 침묵을 깬다. 응답 최상위
  // (data의 형제, conversations.py:2165) references.dropped[]를 트리거 메시지 id에 keyed
  // 적재(commandHints와 동일 ephemeral 패턴 — persist 안 함·reload 시 소멸, 저장 성공/실패
  // 자체는 이미 DB에 반영돼 있어 잃을 정보가 없다).
  const [referenceDropHints, setReferenceDropHints] = useState<Record<string, DroppedReference[]>>({});
  // story #2262 PR② — 참조 칩 「지금 상태」 배치조회 캐시. 대화 전체에서 하나(같은 엔티티를
  // 여러 메시지가 참조해도 fetch는 「타입:id」당 1회) — 키는 `${entityType}:${entityId}`(소문자).
  const [entityStatusByKey, setEntityStatusByKey] = useState<Record<string, EntityStatusFetchState>>({});
  // fetch 이미 시작한 키(loading/resolved/error 무관) — React state가 아니라 ref인 이유는
  // 이 값을 읽어 effect의 재실행 여부를 판단하지 않기 때문(state로 하면 setState가 effect를
  // 재트리거해 순환 위험). messages만 dependency로 두고 "새로 보인 참조가 있는가"만 본다.
  const requestedEntityStatusKeysRef = useRef<Set<string>>(new Set());
  // story #5ace2e84 — 결재카드 gate 배치조회 캐시(entityStatusByKey와 동일 정신·같은
  // requestedKeysRef 패턴). PO 실측: 카드마다 독립 fetchGate()가 대화당 최대 51발(고유 38·
  // 중복 13) N+1을 냈다 — 대화 전체 메시지를 한 번에 훑어 `?ids=` 배치(use-gate-batch.ts)로
  // 수렴시킨다.
  const [gateByKey, setGateByKey] = useState<Record<string, GateCardState>>({});
  const requestedGateIdsRef = useRef<Set<string>>(new Set());
  // story #2637 — event_definitions 카탈로그(block_template 포함) 배치조회. entityStatusByKey와
  // 같은 이유로 대화당 1회만 fetch(카탈로그는 event_key 조합에 무관하게 항상 전체를 돌려주는
  // 응답이라, 메시지별로 다시 부를 이유가 없다 — 메시지가 100개여도 fetch는 1회).
  const [eventDefinitionsByKey, setEventDefinitionsByKey] = useState<Record<string, EventDefinitionSummary> | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetchWithAuth('/api/events/definitions')
      .then((r) => (r.ok ? r.json() : null))
      .then((json: unknown) => {
        if (cancelled || !json) return;
        const list = Array.isArray(json) ? json as EventDefinitionSummary[] : [];
        const byKey: Record<string, EventDefinitionSummary> = {};
        for (const d of list) byKey[d.key] = d;
        setEventDefinitionsByKey(byKey);
      })
      .catch(() => { /* non-critical — 렌더러가 못 찾으면 제네릭 폴백으로 graceful */ });
    return () => { cancelled = true; };
  }, []);
  // 1aeecdde P2: 답장 생성 중 에이전트 typing — #1353 GET /working 폴링(BE 45s TTL) 결과.
  const [typingAgents, setTypingAgents] = useState<{ id: string; name: string }[]>([]);
  // Deeplink (ade2d6d5): 진입 메시지를 일시적으로 하이라이트(ring). null이면 미표시.
  const [highlightId, setHighlightId] = useState<string | null>(null);
  // CB-S9: 스레드 패널 상태
  const [activeThread, setActiveThread] = useState<ChatMessage | null>(null);
  const [threadIncoming, setThreadIncoming] = useState<ChatMessage | null>(null);
  // activeThread 열림 여부를 ref로 추적 — popstate 핸들러 stale closure 방지
  const activeThreadRef = useRef(false);

  // story #2766(레인 A) — ReadingPanel도 우측 패널이라 스레드와 동일 슬롯을 공유한다(동시
  // 2패널 레이아웃은 인계 doc에 없는 새 영역이라 짓지 않음 — 열면 서로 배타적으로 닫는다).
  // story #2888/S2 R5 — 단일 target에서 스택(배열)으로. 빈 배열=닫힘(기존 null과 동형).
  // story #2904 — 스택 오케스트레이션(최대 깊이 truncation·history 1회 정책)은
  // use-reading-panel-stack.ts로 추출(단위 테스트 가능). 이 컴포넌트는 스레드 패널과의
  // 상호배타(activeThread 클리어)만 감싸서 얹는다.
  // 훅이 반환하는 객체 자체는 매 렌더 새 참조라 그대로 deps에 넣으면 콜백 메모이제이션이
  // 무의미해진다(exhaustive-deps도 "readingPanel 전체"를 요구해 그 무의미함을 강제) — 여기서
  // 바로 구조분해해 안정 참조(각 함수는 훅 내부 useCallback([])로 고정)만 아래에서 쓴다.
  const { stack: readingPanelStack, isOpenRef: activeReadingPanelRef, open: openReadingPanelStack, close: closeReadingPanelStack, navigateTo: navigateReadingPanelTo } = useReadingPanelStack();

  // story #2921 S6 — layout.tsx의 리스트 레일에 "지금 ReadingPanel이 열려 있는지"를 끌어올린다
  // (xl 미만에서 rail 자동 접힘 판단에 필요, 이 컴포넌트만 아는 상태라 layout.tsx가 직접 볼 수
  // 없다). Thread는 이 신호 대상이 아니다(chat-rail-context.tsx 주석 — w-80이 480보다 훨씬
  // 좁아 같은 폭에서 눌림이 덜하고 유나 확定 문구가 "Reading 열림"만 명시).
  const { railMode, setReadingOpen } = useChatRail();
  useEffect(() => {
    setReadingOpen(readingPanelStack.length > 0);
  }, [readingPanelStack.length, setReadingOpen]);

  // 스레드 열기: 현재 URL 유지한 채 history entry 추가
  const openThread = useCallback((message: ChatMessage) => {
    closeReadingPanelStack();
    setActiveThread(message);
    activeThreadRef.current = true;
    const url = window.location.pathname + window.location.search;
    window.history.pushState({ _sprintableThread: true }, '', url);
  }, [closeReadingPanelStack]);

  // 스레드 닫기: history.back() 제거 — Next.js router와 충돌 방지 (P0 리그레션 원인)
  const closeThread = useCallback(() => {
    activeThreadRef.current = false;
    setActiveThread(null);
  }, []);

  // story #2888/S2 R5 — 패널이 이미 열려 있으면(스택 비어있지 않음) push(임베드 안에서 또
  // 임베드), 닫혀 있었으면 새 1단 스택으로 시작(정확한 truncation·history 정책은
  // use-reading-panel-stack.ts#open 참고).
  const openReadingPanel = useCallback((target: ReadingPanelTarget) => {
    activeThreadRef.current = false;
    setActiveThread(null);
    openReadingPanelStack(target);
  }, [openReadingPanelStack]);

  const closeReadingPanel = closeReadingPanelStack;
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const isFirstLoad = useRef(true);
  // Deeplink (ade2d6d5): 하이라이트 클리어 타이머·중복 스크롤 가드·페이지 로드 시도 카운터(런어웨이 방지).
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastScrolledIdRef = useRef<string | null>(null);
  const scrollTargetRef = useRef<string | undefined>(undefined);
  const scrollLoadAttemptsRef = useRef(0);
  // scroll race fix: rAF(post-paint 측정)·settle 디바운스(prepend/이미지로드로 target 밀림 재보정)·done(유저 스크롤 존중).
  const scrollRafRef = useRef<number | null>(null);
  const scrollSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollDoneRef = useRef(false);
  // CB-S8: render 후 스크롤 트리거용 ref (setTimeout 패턴 대체)
  const shouldScrollToBottomRef = useRef(false);
  // CB-S8: pull-to-refresh 터치 추적
  const touchStartYRef = useRef<number | null>(null);
  // story #1987: 네이티브 터치 리스너(non-passive)에서 즉시 읽을 pullDistance — state는 리렌더 배치라
  // 다음 touchmove 틱까지 반영이 안 늦어질 수 있어 판정용으로는 ref를 별도로 둔다(렌더용 state는 유지).
  const pullDistanceRef = useRef(0);
  const [pullDistance, setPullDistance] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const PULL_THRESHOLD = 64;
  // story #1977: "여기부터 안읽음" 마커 경계 — 진입 시점 initialLastReadAt에 동결(첫 정의값에서만
  // 1회 세팅). initialLastReadAt은 meta fetch(page.tsx)와 별개 레이스로 undefined→값 순서로
  // 도착할 수 있어 useEffect로 "처음 정의되는 순간"을 잡는다 — 그 이후로는 이 화면에서 스크롤이나
  // mark-read가 일어나도 마커 위치가 안 움직인다(같은 방문 세션 내 유지, 재방문 시에만 재계산).
  const [markerBoundary, setMarkerBoundary] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (markerBoundary === undefined && initialLastReadAt !== undefined) {
      setMarkerBoundary(initialLastReadAt);
    }
  }, [initialLastReadAt, markerBoundary]);

  // story #2262 PR② — 참조 칩 「지금 상태」 배치조회(메인 채널 메시지 담당). requestedEntityStatusKeysRef·
  // setEntityStatusByKey를 ThreadPanel에도 그대로 물려줘(아래 렌더부) 스레드 답글 전용 참조도
  // 같은 장부·같은 캐시로 잡힌다(PO 지적 2026-08-08 — 이전엔 스레드 전용 참조가 영원히
  // "아직 모름"에 고착됐었다).
  useEntityStatusBatchFetch(messages, requestedEntityStatusKeysRef, setEntityStatusByKey);
  // story #5ace2e84 — 결재카드 gate 배치조회(위 entityStatusByKey와 동일 패턴). requestedGateIdsRef·
  // setGateByKey를 ThreadPanel에도 그대로 물려줘(아래 렌더부) 스레드 답글의 결재카드도 같은
  // 장부·같은 캐시로 잡힌다.
  useGateBatchFetch(messages, requestedGateIdsRef, setGateByKey);
  // story #1977: mark-read 중복 POST 가드 — 이미 이 up_to까지 보냈으면 재전송 안 함(멱등이라
  // 서버는 안전하지만, 스크롤/신규메시지마다 매번 쏘는 낭비 방지).
  const markedReadUpToRef = useRef<string | null>(null);
  const markRead = useCallback((upToIso: string) => {
    if (markedReadUpToRef.current && markedReadUpToRef.current >= upToIso) return;
    markedReadUpToRef.current = upToIso;
    fetch(`${apiPrefix}/${threadId}/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ up_to: upToIso }),
    }).catch(() => {
      // 실패 시 재시도 허용 — 다음 스크롤/신규메시지 트리거가 다시 시도(§4-3 GREATEST 래칫이라 안전).
      markedReadUpToRef.current = null;
    });
  }, [apiPrefix, threadId]);

  const scrollToBottom = useCallback((smooth = false) => {
    bottomRef.current?.scrollIntoView({ behavior: smooth ? 'smooth' : 'instant' });
  }, []);

  // AC2: 하단 50px 이내인지 판별
  const isNearBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= 50;
  }, []);

  const fetchMessages = useCallback(async (before?: string): Promise<ChatMessage[] | undefined> => {
    let merged: ChatMessage[] | undefined;
    try {
      const params = new URLSearchParams({ limit: '50' });
      if (before) params.set('before', before);
      const res = await fetch(`${apiPrefix}/${threadId}/messages?${params.toString()}`);
      if (!res.ok) return undefined;
      // Backend: { data: _to_chat_message[], meta: { next_cursor, has_more } }
      const raw = await res.json() as Record<string, unknown>;
      const rawData = (Array.isArray(raw) ? raw : (raw.data ?? [])) as Record<string, unknown>[];
      const meta = Array.isArray(raw) ? null : raw.meta as { next_cursor?: string; has_more?: boolean } | undefined;
      const data = rawData.map(normalizeToMessage);
      if (before) {
        setMessages((prev) => { merged = [...data, ...prev]; return merged; });
      } else {
        setMessages((prev) => { merged = mergeBackfilledMessages(prev, data); return merged; });
      }
      setCursor(meta?.next_cursor ?? null);
      setHasMore(meta?.has_more ?? false);
      return merged;
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [threadId, apiPrefix]);

  useEffect(() => {
    fetchMessages();
  }, [fetchMessages]);

  useEffect(() => {
    if (!loading && isFirstLoad.current) {
      // Deeplink (ade2d6d5): scrollToMessageId가 있으면 하단 자동스크롤을 건너뛴다
      // (scroll-to-message와 충돌 방지). 일반 진입(messageId 부재)은 기존대로 하단 스크롤.
      if (!scrollToMessageId) {
        scrollToBottom();
        // story #1977: 딥링크(특정 옛 메시지로 진입)가 아닌 일반 진입은 곧장 최신까지 본 것 —
        // 마지막 메시지 시각으로 mark-read. 딥링크 경로는 스크롤로 하단 도달 시(아래 onScroll)에만.
        const latest = messages[messages.length - 1];
        if (latest) markRead(latest.created_at);
      }
      isFirstLoad.current = false;
    }
  }, [loading, scrollToBottom, scrollToMessageId, messages, markRead]);

  // Deeplink (ade2d6d5): 언마운트 시 타이머/rAF 정리(메모리·setState-after-unmount 방지).
  useEffect(() => () => {
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    if (scrollSettleTimerRef.current) clearTimeout(scrollSettleTimerRef.current);
    if (scrollRafRef.current != null) cancelAnimationFrame(scrollRafRef.current);
  }, []);

  // 1aeecdde P2: 에이전트 typing 즉시 해제(답장 메시지 도착 시·다음 폴링 전 갭 제거).
  const clearTyping = useCallback((agentId: string) => {
    setTypingAgents((prev) => (prev.some((a) => a.id === agentId) ? prev.filter((a) => a.id !== agentId) : prev));
  }, []);

  const addMessage = useCallback((msg: ChatMessage) => {
    clearTyping(msg.created_by); // 답장 도착 → 해당 에이전트 typing 즉시 해제(AC1)
    const nearBottom = isNearBottom();
    setMessages((prev) => {
      if (prev.some((m) => m.id === msg.id)) return prev;
      return [...prev, msg];
    });
    // CB-S8: setTimeout 대신 ref 플래그 → render 완료 후 useEffect에서 스크롤
    if (nearBottom) {
      shouldScrollToBottomRef.current = true;
      // story #1977: 이미 하단을 보고 있던 활성 뷰어라면 신규 메시지도 즉시 mark-read —
      // 안 그러면 GNB/리스트 배지가 능동 열람 중에도 잠깐 튀어오른다.
      markRead(msg.created_at);
    } else {
      setShowNewIndicator(true);
    }
  }, [isNearBottom, clearTyping, markRead]);

  // HIGH-2: conversation:message SSE — payload uses conversation_id (normalizeToMessage maps it to memo_id)
  const handleConversationMessage = useCallback((payload: Record<string, unknown>) => {
    const conversationId = (payload.conversation_id ?? payload.id) as string | undefined;
    if (conversationId !== threadId) return;
    const msg = normalizeToMessage(payload);
    // CB-S9: thread reply → inject into thread panel; top-level → add to main + update reply_count
    if (msg.parent_id) {
      setThreadIncoming(msg);
      // Update reply_count on parent message in the main list
      setMessages((prev) =>
        prev.map((m) =>
          m.id === msg.parent_id
            ? { ...m, reply_count: (m.reply_count ?? 0) + 1, last_reply_at: msg.created_at }
            : m,
        ),
      );
    } else {
      addMessage(msg);
    }
  }, [threadId, addMessage]);

  // AC4: 재연결 시 누락 메시지 backfill
  // story #3081(정본 ③) — backfill이 놓친 신규 메시지를 채워도 이 fetchMessages 경로는
  // addMessage(SSE 실시간 수신)와 달리 markRead를 안 태웠다 — 활성 뷰어가 하단을 보고
  // 있어도 배지가 안 꺼지는 갭. fetchMessages가 반환하는 실 데이터(merged 결과)로
  // 최신 메시지를 판별해 addMessage와 동일 조건(isNearBottom)으로 mark-read한다.
  const handleReconnect = useCallback(() => {
    void fetchMessages().then((latest) => {
      const markReadIso = resolveBackfillMarkReadIso(latest, isNearBottom());
      if (markReadIso) markRead(markReadIso);
    });
  }, [fetchMessages, isNearBottom, markRead]);

  // 1aeecdde P2: working 폴링(#1353 GET /working·in-memory 45s TTL) → typingAgents.
  // 이름=commandTargets(없으면 미표시 graceful). poll이 BE working 셋 그대로 반영(클라 TTL 불요).
  const fetchWorking = useCallback(async () => {
    try {
      const res = await fetchWithAuth(`/api/conversations/${threadId}/working`);
      if (!res.ok) return;
      const json = await res.json() as { data?: Array<{ member_id: string }> };
      const next = (json.data ?? [])
        .map((w) => ({ id: w.member_id, name: (commandTargets ?? []).find((tg) => tg.agentId === w.member_id)?.agentName }))
        .filter((a): a is { id: string; name: string } => !!a.name);
      setTypingAgents(next);
    } catch { /* non-critical */ }
  }, [threadId, commandTargets]);

  // R2(da9d1781): 1.5s working 폴 제거 → conversation.working SSE 이벤트로 typing 갱신(payload 가
  // working 목록을 실음). 마운트 1회 fetch 로 초기 상태만(이벤트는 변경 시 push). 재연결 시도 catch-up.
  const handleWorking = useCallback((payload: SseWorkingPayload) => {
    if (payload.conversation_id !== threadId) return;
    const next = (payload.working ?? [])
      .map((w) => ({ id: w.member_id, name: (commandTargets ?? []).find((tg) => tg.agentId === w.member_id)?.agentName }))
      .filter((a): a is { id: string; name: string } => !!a.name);
    setTypingAgents(next);
  }, [threadId, commandTargets]);

  useEffect(() => { void fetchWorking(); }, [fetchWorking]);

  // story #2987 — AC2 후반(연결 끊김 표시+수동 갱신). `connected`는 훅이 이미 반환하던 값
  // (mux 경로는 getter로 최신값을 항상 읽되 참조 안정적 — story #2144)인데 이 컴포넌트가
  // 그동안 아무도 안 읽고 있었다.
  const { connected } = useChatSse({
    currentTeamMemberId,
    onConversationMessage: handleConversationMessage,
    onWorking: handleWorking,
    onReconnect: handleReconnect,
  });
  // 짧은 순단(정상 60초 재연결 사이클, sse-reconnect-backoff.ts 주석 참고)까지 매번 배너를
  // 띄우면 소음이라, 끊김이 일정 시간(2s) 이상 지속될 때만 보인다 — 자동 재연결(#2987 §1)이
  // 대부분 그 안에 복구하므로 실사용자는 배너를 거의 못 본다. 안 붙으면(주소창 없는 앱에서
  // 자동 재연결도 실패) 수동 갱신 affordance가 유일한 탈출구가 된다.
  const [showDisconnectedBanner, setShowDisconnectedBanner] = useState(false);
  useEffect(() => {
    if (connected) { setShowDisconnectedBanner(false); return; }
    const timer = setTimeout(() => setShowDisconnectedBanner(true), 2000);
    return () => clearTimeout(timer);
  }, [connected]);

  // fix: popstate — 스레드/리딩패널 열린 상태에서만 가로채기 (Next.js 네비게이션 비간섭)
  useEffect(() => {
    const handlePopState = (e: PopStateEvent) => {
      // story #2766(레인 A) — 모바일 뒤로가기 제스처가 ReadingPanel도 ThreadPanel과 동일하게
      // "페이지 이탈"이 아니라 "패널만 닫기"로 소비돼야 한다(전체화면 드로어 규약).
      if (!activeThreadRef.current && !activeReadingPanelRef.current) return; // 둘 다 없으면 Next.js가 처리
      // 패널 닫기 + 현재 URL 재push → 실제 뒤로가기 취소, 채팅 화면 유지
      activeThreadRef.current = false;
      setActiveThread(null);
      closeReadingPanelStack();
      window.history.pushState(e.state ?? null, '', window.location.pathname + window.location.search);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [closeReadingPanelStack, activeReadingPanelRef]);

  // CB-S8: 모바일 pull-to-refresh — 스크롤 최상단에서 아래로 당기면 새로고침
  // fix(story #1987): React onTouch* prop은 루트에 passive로 위임돼 있어(React 17+) preventDefault()가
  // 무효화된다([[feedback-react-onwheel-passive-preventdefault]]와 동일 근본 클래스 — onWheel에서 이미
  // 겪은 버그). 네이티브 오버스크롤 바운스와 커스텀 pull 인디케이터가 동시에 뜨는 원인이었다. addEventListener를
  // {passive: false}로 직결해야 preventDefault가 실제로 네이티브 스크롤을 억제한다.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onTouchStart = (e: TouchEvent) => {
      if (el.scrollTop > 0) return;
      touchStartYRef.current = e.touches[0]?.clientY ?? null;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (touchStartYRef.current === null) return;
      const delta = (e.touches[0]?.clientY ?? 0) - touchStartYRef.current;
      if (delta > 0) {
        // 최상단에서 아래로 당기는 제스처만 가로챈다 — 그 외 스크롤은 네이티브 그대로 통과.
        e.preventDefault();
        const next = Math.min(delta, PULL_THRESHOLD * 1.5);
        pullDistanceRef.current = next;
        setPullDistance(next);
      }
    };

    const onTouchEnd = () => {
      if (pullDistanceRef.current >= PULL_THRESHOLD) {
        setIsRefreshing(true);
        void fetchMessages().finally(() => setIsRefreshing(false));
      }
      pullDistanceRef.current = 0;
      setPullDistance(0);
      touchStartYRef.current = null;
    };

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
    };
  }, [fetchMessages]);

  // CB-S9/story #2319: 메시지 삭제(본인 메시지만) — tombstone(PO 결정, hard delete 아님).
  // 목록에서 빼지 않는다(행이 자리에 남아 placeholder로 보인다 — AC①의 근거: 대화는 여럿이
  // 읽는 자리라 통째로 지우면 답글·맥락이 끊긴다). AC②: 실패는 무조건 사용자에게 보인다
  // (404/500/네트워크 예외 전부) — 예전엔 `if (!res.ok) return`으로 조용히 아무 일도 없었다.
  const handleDeleteMessage = useCallback(async (messageId: string) => {
    try {
      const res = await fetch(`${apiPrefix}/${threadId}/messages/${messageId}`, { method: 'DELETE' });
      if (!res.ok) {
        addToast({ type: 'error', title: t('deleteMessageErrorTitle'), body: t('deleteMessageErrorBody') });
        return;
      }
      const body = (await res.json()) as { deleted_at?: string | null };
      setMessages((prev) => prev.map((m) => (
        m.id === messageId ? { ...m, content: '', deleted_at: body.deleted_at ?? new Date().toISOString() } : m
      )));
    } catch {
      addToast({ type: 'error', title: t('deleteMessageErrorTitle'), body: t('deleteMessageErrorBody') });
    }
  }, [apiPrefix, threadId, addToast, t]);

  // story #2349 — 사용자 차단. 낙관적 오버레이(blockedMemberIds)는 이미 로드된 메시지 목록을
  // 새로고침 없이 즉시 마스킹하려는 것 — 서버 is_blocked_sender는 다음 fetch부터 반영된다.
  const [blockConfirmTarget, setBlockConfirmTarget] = useState<{ memberId: string; memberName: string } | null>(null);
  const [blockedMemberIds, setBlockedMemberIds] = useState<Set<string>>(new Set());
  const [blockSubmitting, setBlockSubmitting] = useState(false);

  const handleRequestBlockUser = useCallback((memberId: string, memberName: string) => {
    setBlockConfirmTarget({ memberId, memberName });
  }, []);

  const handleConfirmBlockUser = useCallback(async () => {
    if (!blockConfirmTarget) return;
    setBlockSubmitting(true);
    try {
      const res = await fetch('/api/user-blocks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blocked_member_id: blockConfirmTarget.memberId }),
      });
      if (!res.ok) {
        addToast({ type: 'error', title: t('blockUserErrorTitle'), body: t('blockUserErrorBody') });
        return;
      }
      setBlockedMemberIds((prev) => new Set(prev).add(blockConfirmTarget.memberId));
      addToast({ type: 'success', title: t('blockUserSuccessTitle') });
    } catch {
      addToast({ type: 'error', title: t('blockUserErrorTitle'), body: t('blockUserErrorBody') });
    } finally {
      setBlockSubmitting(false);
      setBlockConfirmTarget(null);
    }
  }, [blockConfirmTarget, addToast, t]);

  // story #2265(C-7) 저장 조각 — 확定된 range(rangeStartId~rangeEndId, orderedMessageIds
  // 순서 기준 양끝 포함)를 스냅샷으로 얼려 골라진 스토리에 proof로 POST한다. 스냅샷을
  // 얼리는 이유는 PO 판정(2026-07-29): "얼려야 대조가 가능하다" — proof_payload.snapshot
  // 참조.
  const handleSaveCitation = useCallback(async (storyId: string) => {
    const { rangeStartId, rangeEndId } = citeSelection;
    if (!rangeStartId || !rangeEndId) return;
    const startIndex = orderedMessageIds.indexOf(rangeStartId);
    const endIndex = orderedMessageIds.indexOf(rangeEndId);
    if (startIndex === -1 || endIndex === -1) return;
    const rangeMessages = messages.slice(startIndex, endIndex + 1);
    if (rangeMessages.length === 0) return;

    setCitationSaveState('saving');
    try {
      const res = await fetch(`/api/stories/${storyId}/references`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target_type: 'chat_message',
          target_id: rangeStartId,
          form: 'proof',
          proof_payload: {
            conversation_id: threadId,
            start_message_id: rangeStartId,
            end_message_id: rangeEndId,
            snapshot: rangeMessages.map((m) => ({
              message_id: m.id, author_id: m.created_by, content: m.content, created_at: m.created_at,
            })),
          },
        }),
      });
      if (!res.ok) {
        // story #2265(C-7), PO 지적(2026-07-29): 실패를 하나로 뭉치면 사용자가 무엇을
        // 고쳐야 할지 못 가른다 — 원인별로 다른 상태를 세운다(재시도/취소는 항상 남긴다,
        // 조용히 idle로 안 돌아간다 — "저장됐다"고 믿게 만드는 것이 제일 나쁜 자리).
        setCitationSaveState(res.status === 404 ? 'error_permission' : res.status === 400 ? 'error_invalid' : 'error_network');
        return;
      }
      setCitationSaveState('saved');
      setCitationPickerOpen(false);
      window.setTimeout(() => {
        citeSelection.cancel();
        setCitationSaveState('idle');
      }, 1500);
    } catch {
      setCitationSaveState('error_network');
    }
  }, [citeSelection, orderedMessageIds, messages, threadId]);

  // P2 RC: 자신이 보낸 스레드 답글은 SSE 미수신 → 로컬에서 reply_count +1
  const handleReplyAdded = useCallback((parentId: string) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === parentId
          ? { ...m, reply_count: (m.reply_count ?? 0) + 1, last_reply_at: new Date().toISOString() }
          : m,
      ),
    );
  }, []);

  const handleSend = useCallback(async (content: string, mentionedIds?: string[], attachments?: SendAttachment[]) => {
    const body: Record<string, unknown> = { content };
    if (mentionedIds && mentionedIds.length > 0) body.mentioned_ids = mentionedIds;
    if (attachments && attachments.length > 0) body.attachments = attachments;
    const res = await fetch(`${apiPrefix}/${threadId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('Failed to send message');
    // Backend: { data: _to_chat_message } or { forked: true, forked_conversation_id, data }
    const raw = await res.json() as Record<string, unknown>;
    // AC3: DM fork 응답 감지 → 새 그룹 conversation으로 자동 네비게이션
    if (raw.forked === true && typeof raw.forked_conversation_id === 'string') {
      const newPath = pathname.replace(threadId, raw.forked_conversation_id);
      router.push(newPath);
      return;
    }
    const payload = (raw.data ?? raw) as Record<string, unknown>;
    const sent = normalizeToMessage(payload);
    addMessage(sent);
    // S5: 미지원 런타임 차단 hint를 트리거 메시지에 keyed로 적재(차단 발생 시에만 키 존재).
    const gate = raw.command_gate as { blocked?: BlockedHint[] } | undefined;
    const blocked = gate?.blocked;
    if (blocked?.length) {
      setCommandHints((prev) => ({ ...prev, [sent.id]: blocked }));
    }
    // story #2294 AC8/AC11 — references도 raw 최상위(data의 형제)에 실린다. 정상 경로에선
    // dropped가 항상 빈 배열(#2294 AC1이 검색 허용목록을 registry에서 파생시켜 화면이 못
    // 고르는 종류를 애초에 못 보내게 막는다) — 그래도 사람이 손으로 토큰을 치거나 에이전트가
    // API로 본문을 직접 쓰는 경로는 여전히 열려 있어(PO 실측, 2026-07-28) dropped가 비지
    // 않으면 그 자체가 결함 신호다.
    const dropped = parseDroppedReferences(raw);
    if (dropped.length) {
      setReferenceDropHints((prev) => ({ ...prev, [sent.id]: dropped }));
    }
  }, [threadId, addMessage, apiPrefix, pathname, router]);

  const dismissReferenceDropHint = useCallback((messageId: string) => {
    setReferenceDropHints((prev) => {
      if (!(messageId in prev)) return prev;
      const next = { ...prev };
      delete next[messageId];
      return next;
    });
  }, []);

  // chat-attach: 파일을 GCS에 업로드(서버사이드)하고 첨부 메타를 반환 — 유령경로(/api/chats/.../upload) 폐기.
  // 반환된 메타는 chat-input이 모아 handleSend의 attachments로 한 메시지에 함께 전송한다.
  const handleUploadFile = useCallback(async (file: File): Promise<SendAttachment> => {
    const formData = new FormData();
    formData.append('file', file);
    if (projectId) formData.append('project_id', projectId);
    const res = await fetch(`${apiPrefix}/${threadId}/attachments`, {
      method: 'POST',
      body: formData,
    });
    if (!res.ok) throw new Error('Failed to upload attachment');
    return await res.json() as SendAttachment;
  }, [apiPrefix, threadId, projectId]);

  const handleLoadMore = useCallback(async () => {
    if (!hasMore || !cursor || loadingMore) return;
    const scrollEl = scrollRef.current;
    const prevScrollHeight = scrollEl?.scrollHeight ?? 0;
    setLoadingMore(true);
    await fetchMessages(cursor);
    if (scrollEl) {
      scrollEl.scrollTop += scrollEl.scrollHeight - prevScrollHeight;
    }
  }, [hasMore, cursor, loadingMore, fetchMessages]);

  // CB-S8: 매 render 후 플래그 확인 → DOM에 새 메시지 반영된 직후 스크롤
  useEffect(() => {
    if (shouldScrollToBottomRef.current) {
      shouldScrollToBottomRef.current = false;
      scrollToBottom(true);
    }
  });

  // Deeplink (ade2d6d5): scrollToMessageId로 진입 시 해당 메시지로 스크롤 + 하이라이트.
  // 메시지는 cursor 페이지네이션(50/page, 비-가상화)이라 대상이 아직 로드 안 된 이전 페이지에
  // 있으면 이전 페이지를 (바운드 내에서) 로드하며 재시도. messages 변경마다 effect가 재실행되어
  // 로드 후 다시 탐색한다. 대상 미발견·페이지 소진 시 no-op(graceful).
  useEffect(() => {
    if (!scrollToMessageId || loading) return;
    // 대상이 바뀌면 시도/상태 리셋.
    if (scrollTargetRef.current !== scrollToMessageId) {
      scrollTargetRef.current = scrollToMessageId;
      scrollLoadAttemptsRef.current = 0;
      scrollDoneRef.current = false;
    }
    // settle 완료(추가 레이아웃 변화 없음) → 재보정 중단(유저 스크롤 존중).
    if (scrollDoneRef.current) return;

    const container = scrollRef.current;
    if (!container) return;
    const el = container.querySelector<HTMLElement>(`#msg-${CSS.escape(scrollToMessageId)}`);
    if (el) {
      scrollLoadAttemptsRef.current = 0;
      // race fix: 동기 scrollIntoView 는 prepend 페이지 paint/이미지로드 前 측정→target 이 이후
      // 성장으로 밀려 off-screen(top≈15022). rAF 로 paint 後 측정 + messages 변경마다(prepend·이미지) center 재보정.
      if (scrollRafRef.current != null) cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = requestAnimationFrame(() => {
        container.querySelector<HTMLElement>(`#msg-${CSS.escape(scrollToMessageId)}`)?.scrollIntoView({ block: 'center' });
      });
      // 첫 발견 시에만 하이라이트(2.2s).
      if (lastScrolledIdRef.current !== scrollToMessageId) {
        lastScrolledIdRef.current = scrollToMessageId;
        if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
        setHighlightId(scrollToMessageId);
        highlightTimerRef.current = setTimeout(() => setHighlightId(null), 2200);
      }
      // settle 디바운스: 추가 messages 변경 없이 안정되면 done(재보정 정지).
      if (scrollSettleTimerRef.current) clearTimeout(scrollSettleTimerRef.current);
      scrollSettleTimerRef.current = setTimeout(() => { scrollDoneRef.current = true; }, 600);
      return;
    }
    // 미발견 + 이전 페이지 존재 → 바운드 내에서 이전 페이지 로드 후 재시도(messages 변경→effect 재실행).
    if (hasMore && !loadingMore && scrollLoadAttemptsRef.current < MAX_SCROLL_LOAD_ATTEMPTS) {
      scrollLoadAttemptsRef.current += 1;
      void handleLoadMore();
    }
  }, [scrollToMessageId, loading, messages, hasMore, loadingMore, handleLoadMore]);

  // 스크롤을 직접 내리면 인디케이터 자동 해제 + story #1977: 하단 근접 시 mark-read(마커를
  // 지나 실제로 최신까지 봤을 때만 — 시안 "스크롤 하단 근접 시 POST /read up_to=최신 본 메시지").
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      if (isNearBottom()) {
        setShowNewIndicator(false);
        const latest = messages[messages.length - 1];
        if (latest) markRead(latest.created_at);
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [isNearBottom, messages, markRead]);

  // Auto-load when scrolled to top (IntersectionObserver watches topSentinelRef inside scrollRef)
  useEffect(() => {
    const sentinel = topSentinelRef.current;
    const container = scrollRef.current;
    if (!sentinel || !container || loading) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting && hasMore && !loadingMore) {
          void handleLoadMore();
        }
      },
      { root: container, threshold: 0 },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loading, hasMore, loadingMore, handleLoadMore]);

  // story #2572 AC3: 이미 답변된 승인 요청은 버튼을 잠근다(다른 기기·새로고침 후에도 유지).
  // 요청(에이전트 발신, 고정 포맷) 다음에 오는 첫 human allow/deny 답을 그 요청의 답으로
  // 짝짓는다 — 새 요청이 끼어들면 미답변인 채로 넘어간다(그 사이 pendingRequestId 재대입).
  const hitlAnswers = useMemo(() => {
    const map = new Map<string, HitlAnswer>();
    let pendingRequestId: string | null = null;
    for (const m of messages) {
      if (m.sender_type === 'agent' && parseHitlRequest(m.content)) {
        pendingRequestId = m.id;
        continue;
      }
      if (pendingRequestId && m.sender_type === 'human') {
        const reply = isHitlReply(m.content);
        if (reply) {
          map.set(pendingRequestId, reply);
          pendingRequestId = null;
        }
      }
    }
    return map;
  }, [messages]);

  const groups = groupByDate(messages, locale, displayTimezone);

  // story #1977: "여기부터 안읽음" 마커 위치 — markerBoundary(동결된 진입 시점 last_read_at)
  // 이후·타인 발신(§4-1 BE unread 정의 sender IS DISTINCT FROM 나와 동형) 첫 메시지 앞.
  // markerBoundary===undefined(아직 로드 전)면 마커 계산을 보류(오판 방지) — 값 도착 시 자동 재계산.
  const unreadMarkerMessageId = markerBoundary === undefined ? null : (() => {
    const boundaryMs = markerBoundary === null ? 0 : new Date(markerBoundary).getTime();
    const firstUnread = messages.find(
      (m) => m.created_by !== currentTeamMemberId && new Date(m.created_at).getTime() > boundaryMs,
    );
    return firstUnread?.id ?? null;
  })();

  // CB-S9: 모바일에서 스레드 뷰로 전환 중인지 (< lg)
  const isMobileThreadView = activeThread !== null;
  // story #2766(레인 A) — ReadingPanel도 같은 "메인 채팅 숨김" 규칙을 탄다(모바일 전체화면
  // 드로어). ReadingPanel 자신이 이미 자체 닫기(X) 버튼을 갖고 있어(FileViewer/EntityPreviewModal
  // 헤더) ThreadPanel처럼 별도 상단 "뒤로" 바를 새로 만들지 않는다.
  const isMobileReadingView = readingPanelStack.length > 0;
  const isMobileRightPanelView = isMobileThreadView || isMobileReadingView;

  const unconnectedAgentParticipants = filterUnconnectedAgentParticipants(participants, currentTeamMemberId);

  // story #461e9a54(P0) — 채팅 하위 트리 전체(메시지·입력창 포함)를 이 Provider로 감싼다.
  // EntityChip(embed-card.tsx)·approval-request-card.tsx가 이 값을 useReadingPanel()로
  // 직접 소비 — prop-drilling 없이도 새 임베드 소비처가 자동으로 패널行 된다.
  const readingPanelContextValue = useMemo(
    () => ({ open: openReadingPanel, close: closeReadingPanel, navigateTo: navigateReadingPanelTo }),
    [openReadingPanel, closeReadingPanel, navigateReadingPanelTo],
  );

  return (
    <ReadingPanelProvider value={readingPanelContextValue}>
    <div className="flex h-full flex-col overflow-hidden">
      {/* Mobile thread back — only while a thread panel is open (closes it). The page
          TopBar owns the conversation header, so this no longer duplicates it (S2). */}
      {isMobileThreadView && (
        <div className="flex flex-shrink-0 items-center gap-2 border-b border-border/80 px-3 py-2 lg:hidden">
          <button
            type="button"
            onClick={closeThread}
            className="flex min-h-[44px] items-center gap-1 px-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="h-4 w-4" />
            대화
          </button>
          <span className="truncate text-sm font-medium text-foreground">스레드</span>
        </div>
      )}

      {/* Body: main chat + optional thread panel (side-by-side on desktop) */}
      <div className="flex min-h-0 flex-1 overflow-hidden">

        {/* Main chat — AC8: 모바일에서 스레드/리딩패널 뷰 활성 시 hidden */}
        <div className={`flex min-w-0 flex-1 flex-col overflow-hidden ${isMobileRightPanelView ? 'hidden lg:flex' : 'flex'}`}>
          {/* story #2987 AC2 후반 — 자동 재연결(§1)이 대부분 소리 없이 복구하지만, 실패하면
              (예: 서버가 실제로 죽음) 주소창 없는 앱에선 새로고침 우회조차 없다 — 수동 갱신
              affordance가 유일한 탈출구. 빨강(destructive) 아님 — "네가 실패했다"가 아니라
              "연결이 끊긴 상태"(reference-drop-notice.tsx와 동일 warning-tint 관례). */}
          {showDisconnectedBanner && (
            <div className="flex flex-shrink-0 items-center gap-2 border-b border-warning-border bg-warning-tint px-3 py-2 text-xs text-foreground">
              <WifiOff className="h-3.5 w-3.5 flex-shrink-0" />
              <span className="flex-1">{t('connectionLost')}</span>
              <button
                type="button"
                onClick={() => void fetchMessages()}
                className="flex items-center gap-1 rounded px-1.5 py-1 font-medium hover:bg-warning-border/40"
              >
                <RefreshCw className="h-3 w-3" />
                {t('refreshNow')}
              </button>
            </div>
          )}
          {/* story #3194(PO 신규 회원 친절도 실측) — 미연결 에이전트에게 첫 메시지를 보내도
              화면 어디에도 신호가 없어 "제품이 죽었다"로 읽히던 결함. 판별자(verified===false)
              는 #2751이 워크포스 목록에 쓰는 get_verified_map 그대로(발명 0) — 여기서 새
              판정을 만들지 않는다. 연결되면(다음 폴링 사이클, page.tsx fetchPresence 15s)
              participants의 verified가 갱신돼 이 배너는 조건이 저절로 꺼진다(자연 소멸,
              별도 dismiss 상태 불요). */}
          {unconnectedAgentParticipants.length > 0 && (
            <div className="flex flex-shrink-0 items-center gap-2 border-b border-warning-border bg-warning-tint px-3 py-2 text-xs text-foreground">
              <UserX className="h-3.5 w-3.5 flex-shrink-0" />
              <span className="flex-1">
                {unconnectedAgentParticipants.length === 1
                  ? t('agentNotConnectedBanner', { name: unconnectedAgentParticipants[0]!.name ?? '?' })
                  : t('agentNotConnectedBannerMulti', { count: unconnectedAgentParticipants.length })}
              </span>
              <Link
                href={`/organization/workforce/${unconnectedAgentParticipants[0]!.member_id}`}
                className="flex items-center gap-1 rounded px-1.5 py-1 font-medium hover:bg-warning-border/40"
              >
                {ta('viewConnectionSettings')}
              </Link>
            </div>
          )}
          {/* Messages */}
          <div
            ref={scrollRef}
            className="relative min-h-0 flex-1 overflow-y-auto px-4 py-3"
          >
            {/* CB-S8: pull-to-refresh 인디케이터 */}
            {(pullDistance > 0 || isRefreshing) && (
              <div
                className="pointer-events-none flex justify-center pb-2 transition-all"
                style={{ height: isRefreshing ? 40 : pullDistance * 0.6 }}
              >
                <RefreshCw
                  className={`h-5 w-5 text-muted-foreground transition-transform ${isRefreshing ? 'animate-spin' : ''}`}
                  style={{ transform: `rotate(${(pullDistance / PULL_THRESHOLD) * 180}deg)` }}
                />
              </div>
            )}
            {loading ? (
              <div className="flex h-full items-center justify-center">
                <p className="text-sm text-muted-foreground">불러오는 중…</p>
              </div>
            ) : messages.length === 0 ? (
              <div className="flex h-full items-center justify-center">
                <EmptyState
                  title="대화를 시작하세요"
                  description="첫 메시지를 보내면 대화가 시작됩니다."
                  className="w-full max-w-xs"
                />
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                {/* sentinel: IntersectionObserver triggers auto-load when scrolled to top */}
                <div ref={topSentinelRef} className="h-px w-full" />
                {hasMore && (
                  <div className="flex justify-center">
                    <button
                      type="button"
                      onClick={() => void handleLoadMore()}
                      disabled={loadingMore}
                      className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
                    >
                      {loadingMore ? '불러오는 중…' : '이전 메시지 보기'}
                    </button>
                  </div>
                )}

                {groups.map((group) => (
                  <div key={group.date} className="flex flex-col gap-3">
                    <div className="flex items-center gap-3">
                      <div className="h-px flex-1 bg-border/60" />
                      <span className="text-[11px] text-muted-foreground">{group.date}</span>
                      <div className="h-px flex-1 bg-border/60" />
                    </div>

                    {group.messages.map((msg, idx) => {
                      const prev = group.messages[idx - 1];
                      const isGrouped = Boolean(prev && prev.created_by === msg.created_by);
                      return (
                        <Fragment key={msg.id}>
                          {/* story #1977: "여기부터 안읽음" — info 톤(안내), 빨강 0(시안 768e89b5 v2). */}
                          {msg.id === unreadMarkerMessageId && (
                            <div className="my-1 flex items-center gap-2.5" role="separator" aria-label={t('unreadMarker')}>
                              <div className="h-px flex-1 bg-info/50" />
                              {/* story #2590(TIER3) — tint 위 계열색 글자는 text-foreground(#2420 규칙). */}
                              <span className="rounded-full bg-info-tint px-3 py-0.5 text-[11px] font-bold text-foreground">
                                {t('unreadMarker')}
                              </span>
                              <div className="h-px flex-1 bg-info/50" />
                            </div>
                          )}
                          <ChatBubble
                            message={
                              blockedMemberIds.has(msg.created_by) && msg.is_blocked_sender !== true
                                ? { ...msg, is_blocked_sender: true }
                                : msg
                            }
                            isMine={msg.created_by === currentTeamMemberId}
                            isGrouped={isGrouped}
                            onOpenThread={openThread}
                            onOpenReadingPanel={openReadingPanel}
                            onDelete={handleDeleteMessage}
                            onBlockUser={
                              msg.created_by !== currentTeamMemberId
                                ? () => handleRequestBlockUser(msg.created_by, msg.sender_name)
                                : undefined
                            }
                            presenceStatus={presenceById?.[msg.created_by]}
                            isWorking={typingAgents.some((a) => a.id === msg.created_by)}
                            highlight={msg.id === highlightId}
                            projectId={projectId}
                            entityStatusByKey={entityStatusByKey}
              eventDefinitionsByKey={eventDefinitionsByKey}
                            gateByKey={gateByKey}
                            onFillComposer={handleFillComposer}
                            hitlAnswer={hitlAnswers.get(msg.id) ?? null}
                            onRespondHitl={(content) => handleSend(content)}
                            isCiteAnchor={citeSelection.isAnchor(msg.id)}
                            isCiteInRange={citeSelection.isInRange(msg.id, orderedMessageIds)}
                            citeAction={
                              citeSelection.mode === 'confirming'
                                ? undefined // 범위 확定 후엔 저장/취소를 먼저 끝내게(재선택은 취소부터).
                                : citeSelection.mode === 'anchored'
                                  ? { kind: 'end', onSelect: () => citeSelection.confirmEnd(msg.id, orderedMessageIds) }
                                  : { kind: 'start', onSelect: () => citeSelection.startSelection(msg.id) }
                            }
                          />
                          {/* S5: 트리거 메시지 직후 차단 hint notice(차단 에이전트별 1건) */}
                          {commandHints[msg.id]?.map((h) => (
                            <CommandHintNotice key={h.agent_id} hint={h} />
                          ))}
                          {/* story #2294 AC8: 트리거 메시지 직후 참조 저장실패 notice(종류-무관 1건) */}
                          {referenceDropHints[msg.id] && (
                            <ReferenceDropNotice
                              dropped={referenceDropHints[msg.id]!}
                              onDismiss={() => dismissReferenceDropHint(msg.id)}
                            />
                          )}
                        </Fragment>
                      );
                    })}
                  </div>
                ))}

                <div ref={bottomRef} />
              </div>
            )}
          </div>

          {/* AC2(CB-S8): 새 메시지 인디케이터 */}
          {showNewIndicator && (
            <div className="flex flex-shrink-0 justify-center py-1">
              <button
                type="button"
                onClick={() => { setShowNewIndicator(false); scrollToBottom(true); }}
                className="rounded-full border border-border bg-background px-3 py-1 text-xs font-medium text-primary shadow-sm transition-colors hover:bg-muted/50"
              >
                ↓ 새 메시지
              </button>
            </div>
          )}

          {/* 1aeecdde P2: "...is typing" — 메시지 리스트 아래·composer 위·답장 생성 중·완료 시 사라짐(aria-live) */}
          {typingAgents.length > 0 && (
            <div className="flex flex-shrink-0 items-center gap-2 px-4 py-1.5 text-xs text-muted-foreground" aria-live="polite">
              <span className="flex items-center gap-0.5" aria-hidden>
                <span className="size-1.5 rounded-full bg-muted-foreground motion-safe:animate-bounce" />
                <span className="size-1.5 rounded-full bg-muted-foreground motion-safe:animate-bounce [animation-delay:150ms]" />
                <span className="size-1.5 rounded-full bg-muted-foreground motion-safe:animate-bounce [animation-delay:300ms]" />
              </span>
              <span>
                {typingAgents.length === 1
                  ? t('isTyping', { name: typingAgents[0]?.name ?? '' })
                  : t('othersTyping', { name: typingAgents[0]?.name ?? '', count: typingAgents.length - 1 })}
              </span>
            </div>
          )}

          {/* story #2265(C-7) 저장 조각 — 선택 중/확定 후 안내+저장. idle이면 안 뜬다(무변화). */}
          {citeSelection.mode !== 'idle' && (
            <CitationComposeBar
              mode={citeSelection.mode}
              selectedCount={
                citeSelection.rangeStartId && citeSelection.rangeEndId
                  ? Math.max(0, orderedMessageIds.indexOf(citeSelection.rangeEndId) - orderedMessageIds.indexOf(citeSelection.rangeStartId) + 1)
                  : 0
              }
              saveState={citationSaveState}
              onCancel={() => { citeSelection.cancel(); setCitationSaveState('idle'); }}
              onSave={() => { if (projectId) setCitationPickerOpen(true); }}
            />
          )}

          {/* Input */}
          <ChatInput
            threadId={threadId}
            onSend={handleSend}
            onUploadFile={handleUploadFile}
            projectId={projectId}
            commandTargets={commandTargets}
            placeholder={isMobile ? t('inputPlaceholderMobile') : t('inputPlaceholderFull')}
            onEscape={() => router.replace(backHref)}
            currentTeamMemberId={currentTeamMemberId}
            participants={participants}
            prefillCommand={prefillCommand}
          />

          {/* story #2265(C-7) — 확定된 범위를 어느 스토리에 붙일지 고르는 자리. 기존
              StoryPickerDialog 재사용(새 피커 0). projectId 없으면(비-프로젝트 DM 등)
              저장 버튼 자체를 못 누르게 막지 않고 다이얼로그 진입만 막는다(방어적). */}
          {projectId && (
            <StoryPickerDialog
              open={citationPickerOpen}
              onOpenChange={setCitationPickerOpen}
              projectId={projectId}
              onSelect={(storyId) => { if (storyId) void handleSaveCitation(storyId); }}
            />
          )}
        </div>

        {/* AC7/AC8: 스레드 패널 — 데스크톱 사이드 패널 / 모바일 전체 뷰 */}
        {activeThread && (
          // story #2910(S2f/R3) — ReadingPanel과 동형 slide-in(1회, activeThread가 null→값
          // 전환될 때만 — 다른 스레드로 전환은 ThreadPanel 자체 key가 담당, 이 wrapper는 안
          // 리마운트돼 재발화 없음). exit 애니 의도적 무(ReadingPanel과 동일 판정).
          <div className={`motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-right duration-150 flex flex-col overflow-hidden ${isMobileThreadView ? 'flex-1' : 'hidden w-80 flex-shrink-0 lg:flex'}`}>
            <ThreadPanel
              key={activeThread.id}
              parentMessage={activeThread}
              conversationId={threadId}
              currentTeamMemberId={currentTeamMemberId}
              projectId={projectId}
              onClose={closeThread}
              incomingMessage={threadIncoming?.parent_id === activeThread.id ? threadIncoming : null}
              onReplyAdded={handleReplyAdded}
              onMarkRead={markRead}
              entityStatusByKey={entityStatusByKey}
              eventDefinitionsByKey={eventDefinitionsByKey}
              requestedEntityStatusKeysRef={requestedEntityStatusKeysRef}
              setEntityStatusByKey={setEntityStatusByKey}
              gateByKey={gateByKey}
              requestedGateIdsRef={requestedGateIdsRef}
              setGateByKey={setGateByKey}
            />
          </div>
        )}

        {/* story #2766(레인 A) §A1 — ReadingPanel: 데스크톱 clamp(480px,40vw,720px) 사이드 /
            모바일 전체 뷰. ThreadPanel과 같은 슬롯이지만 폭 규격이 다르다(320px 고정이 아님
            — 문서 가독 기준 폭). */}
        {readingPanelStack.length > 0 && (
          // story #2910(S2f/R3) — 패널이 처음 열릴 때 1회만 slide-in(이 div는 push/pop마다
          // readingPanelStack 참조만 바뀔 뿐 리마운트되지 않아 재발화 안 함 — 스택 전환은
          // reading-panel.tsx 안쪽 콘텐츠 wrapper가 자기 key로 별도 담당, 자연 분리).
          // exit(닫기) 애니는 의도적 무(PO 판정 — 즉시 사라짐=반응성 피드백).
          <div
            className={`motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-right duration-150 flex flex-col overflow-hidden ${isMobileReadingView ? 'flex-1' : 'hidden lg:flex'}`}
            // story #2921 S6(유나 확定④) — rail이 접힌/오버레이 상태(xl 미만+reading 열림)에선
            // clamp 대신 480px 고정(Pedro 산수: main 544 보장은 reading=480 전제). xl↑나
            // reading 닫힘(=railMode 'normal')은 기존 clamp(480,40vw,720) 그대로.
            style={isMobileReadingView ? undefined : { width: railMode === 'normal' ? 'clamp(480px, 40vw, 720px)' : '480px', flexShrink: 0 }}
          >
            <ReadingPanel stack={readingPanelStack} onNavigateTo={navigateReadingPanelTo} onClose={closeReadingPanel} />
          </div>
        )}
      </div>
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
      {/* story #2349 — 「안 바뀌는 것」을 말하는 문장이 핵심(PO 규격, 빼지 않는다). */}
      <ConfirmDialog
        open={blockConfirmTarget !== null}
        onOpenChange={(open) => { if (!open) setBlockConfirmTarget(null); }}
        title={t('blockUserConfirmTitle')}
        description={t('blockUserConfirmDescription', { name: blockConfirmTarget?.memberName ?? '' })}
        cancelLabel={t('blockUserConfirmCancel')}
        confirmLabel={t('blockUserConfirmConfirm')}
        onConfirm={() => { if (!blockSubmitting) void handleConfirmBlockUser(); }}
      />
    </div>
    </ReadingPanelProvider>
  );
}
