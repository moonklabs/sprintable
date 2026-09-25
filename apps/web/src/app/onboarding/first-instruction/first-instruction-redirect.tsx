'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { fetchWithAuth } from '@/lib/db/client';
import { createFirstInstructionConversation } from '@/lib/onboarding/first-instruction';
import { DEFAULT_NAV_V3_FLAGS, resolveNavV3Destinations, type NavV3Flags } from '@/lib/nav-v3-destinations';
import { withProjectParam } from '@/hooks/use-flat-href';

// [SID:4021] compose는 URL 쿼리로 실려 가고, 메시지 content는 서버 스키마(SendMessageRequest.content:
// str·conversation.py content=Text)에 명시 상한이 없다 → «기존 채팅 입력 상한»이 없어 URL-안전 상한을
// 여기서 정한다(과도한 주소 방지). 넘으면 잘라 싣지 않고 안내(AC3).
export const MAX_COMPOSE_LENGTH = 2000;

// 목록/상세 페이지네이션 — DM은 첫 페이지 밖에도 있을 수 있어 total까지 훑는다(PO CHANGES3).
const CONVERSATIONS_PAGE_SIZE = 100;
const MAX_CONVERSATION_PAGES = 20;

interface ParticipantLite {
  member_id: string;
  type?: 'agent' | 'human';
}
export interface ConversationLite {
  id: string;
  type: 'dm' | 'group';
  updated_at?: string;
  participants?: ParticipantLite[];
}

export function participantsIncludeAgent(
  participants: ParticipantLite[] | undefined,
  agentId: string,
): boolean {
  return (participants ?? []).some((p) => p.member_id === agentId);
}

// ② 목록에서 나+이 에이전트 DM 최신 1건(순수). ①(체크리스트)은 대화 상세 조회가 필요해 효과 안에서.
export function pickNewestAgentDm(conversations: ConversationLite[], agentId: string): string | null {
  const dms = conversations
    .filter((c) => c.type === 'dm' && participantsIncludeAgent(c.participants, agentId))
    .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
  return dms[0]?.id ?? null;
}

// 대화 화면 목적지. compose 비면 compose 없이, 상한 넘으면 싣지 않고 tooLong 표시(AC3).
// story #4158 — chatV3Enabled면 v3 셸 딥링크(4404 `?conversation=<id>`+4408 `?compose=`
// 계약)로, OFF면 기존 레거시 `/chats/<id>?compose=` 그대로(AC2 바이트 동일). 목적지
// 문자열은 nav-v3-destinations.ts(resolveNavV3Destinations) 한 곳에서만(AC3).
export function buildFirstInstructionTarget(
  conversationId: string,
  compose: string,
  flags: NavV3Flags,
): { path: string; tooLong: boolean } {
  const chatsPath = resolveNavV3Destinations(flags).chats.path;
  const base = flags.chatV3Enabled ? `${chatsPath}?conversation=${conversationId}` : `${chatsPath}/${conversationId}`;
  if (compose.length > MAX_COMPOSE_LENGTH) {
    return { path: base, tooLong: true };
  }
  if (compose.length === 0) {
    return { path: base, tooLong: false };
  }
  const composeQuery = `compose=${encodeURIComponent(compose)}`;
  return { path: flags.chatV3Enabled ? `${base}&${composeQuery}` : `${base}?${composeQuery}`, tooLong: false };
}

// 이 프로젝트의 에이전트 멤버 id 집합. null = 조회 실패(생성으로 안 넘어감·PO CHANGES2).
async function fetchProjectAgentMemberIds(projectId: string): Promise<Set<string> | null> {
  try {
    const res = await fetchWithAuth(`/api/team-members?project_id=${encodeURIComponent(projectId)}&type=agent`);
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { id: string }[] };
    return new Set((json.data ?? []).map((m) => m.id));
  } catch {
    return null;
  }
}

// 기본 목록만(include_agent_conversations=owner/admin 전용이라 일반 멤버는 403·PO CHANGES2). 내 DM은
// 기본 목록에 있다. total까지 페이지네이션(PO CHANGES3). 한 페이지라도 실패면 null(→ error·생성 0).
async function fetchAllProjectConversations(projectId: string): Promise<ConversationLite[] | null> {
  const all: ConversationLite[] = [];
  for (let page = 0; page < MAX_CONVERSATION_PAGES; page++) {
    const offset = page * CONVERSATIONS_PAGE_SIZE;
    let res: Response;
    try {
      res = await fetchWithAuth(
        `/api/conversations?project_id=${encodeURIComponent(projectId)}&limit=${CONVERSATIONS_PAGE_SIZE}&offset=${offset}`,
      );
    } catch {
      return null;
    }
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: ConversationLite[]; total?: number };
    const items = json.data ?? [];
    all.push(...items);
    const total = json.total ?? all.length;
    if (items.length === 0 || all.length >= total) break;
  }
  return all;
}

// story #4231 — 체크리스트의 첫 지시 대화는 BE가 조직 전체에서 고른다 → 그 대화의 프로젝트(`first_instruction_conversation_project_id`)도 같이.
async function fetchChecklistConversation(): Promise<{ id: string; projectId: string | null } | null> {
  try {
    const res = await fetchWithAuth('/api/activation/checklist');
    if (!res.ok) return null;
    const json = (await res.json()) as {
      data?: { first_instruction_conversation_id: string | null; first_instruction_conversation_project_id?: string | null };
    };
    const id = json.data?.first_instruction_conversation_id ?? null;
    return id ? { id, projectId: json.data?.first_instruction_conversation_project_id ?? null } : null;
  } catch {
    return null;
  }
}

// GET /api/conversations/{id} — 참가자를 최상위에 그대로 실어 준다(chats 상세와 동일 계약). null=조회 실패.
async function fetchConversationParticipants(conversationId: string): Promise<ParticipantLite[] | null> {
  try {
    const res = await fetchWithAuth(`/api/conversations/${conversationId}`);
    if (!res.ok) return null;
    const conv = (await res.json()) as { participants?: ParticipantLite[] };
    return conv.participants ?? [];
  } catch {
    return null;
  }
}

type Phase = 'resolving' | 'error' | 'too_long';

interface FirstInstructionRedirectProps {
  agentId: string | null;
  compose: string;
  projectId: string | null;
  flags?: NavV3Flags;
}

export function FirstInstructionRedirect({
  agentId, compose, projectId, flags = DEFAULT_NAV_V3_FLAGS,
}: FirstInstructionRedirectProps) {
  const t = useTranslations('onboarding');
  const router = useRouter();
  // agent·project가 없으면 애초에 할 게 없다 — 렌더 시점에 error로 시작(효과 내 동기 setState 회피).
  const [phase, setPhase] = useState<Phase>(() => (agentId && projectId ? 'resolving' : 'error'));
  // tooLong일 때 compose 없이 열 대화 주소(안내의 「대화 열기」 링크).
  const [conversationHref, setConversationHref] = useState<string | null>(null);
  // AC2·보탬2 — 효과는 마운트당 1회만(StrictMode 이중 호출·새로고침 이중 생성 방지). 생성 자체의
  // 재발 방지는 «찾기»(멤버십·목록 조회)가 맡는다.
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return;
    // agent·project 없음은 초기 phase가 이미 'error' — 효과는 조용히 끝낸다(setState 0).
    if (!agentId || !projectId) return;
    ranRef.current = true;

    let cancelled = false;
    const fail = () => {
      if (!cancelled) setPhase('error');
    };

    (async () => {
      try {
        // PO CHANGES1 사전확認 — 이 에이전트가 이 프로젝트 멤버인가. 다른 org/없는 멤버면 생성 API가
        // 조용히 빼고 «나 혼자 방»을 만드므로(conversations.py:1417 filter_org_member_ids), 생성 前에
        // 막는다. 멤버십 조회 실패도 error(생성 0·PO CHANGES2).
        const agentMemberIds = await fetchProjectAgentMemberIds(projectId);
        if (cancelled) return;
        if (!agentMemberIds || !agentMemberIds.has(agentId)) {
          fail();
          return;
        }

        // PO CHANGES2/3 — 기본 목록을 total까지. 조회 실패면 생성으로 안 넘어가고 error.
        const conversations = await fetchAllProjectConversations(projectId);
        if (cancelled) return;
        if (!conversations) {
          fail();
          return;
        }

        // ① 체크리스트 first_instruction_conversation_id — 그 대화 참가자에 이 에이전트가 있을 때만
        // (조회는 GET /{id}로·PO CHANGES3). 체크리스트/상세 실패는 ① 건너뛰기(soft).
        let conversationId: string | null = null;
        // story #4231 — 착지 `?p=`는 그 대화의 프로젝트. ②(이 프로젝트 목록) · ③(이 프로젝트에 생성)은 곧 projectId.
        let conversationProjectId: string = projectId;
        const checklist = await fetchChecklistConversation();
        if (cancelled) return;
        if (checklist) {
          const parts = await fetchConversationParticipants(checklist.id);
          if (cancelled) return;
          if (parts && participantsIncludeAgent(parts, agentId)) {
            conversationId = checklist.id;
            // 옛 응답(대화 프로젝트 필드 없음)일 때만 이 온보딩의 프로젝트로 폴백.
            conversationProjectId = checklist.projectId ?? projectId;
          }
        }

        // ② 목록에서 나+이 에이전트 DM 최신 1.
        if (!conversationId) {
          conversationId = pickNewestAgentDm(conversations, agentId);
        }

        // ③ 없을 때만 생성(에이전트는 이미 프로젝트 멤버로 확認됨). 생성 결과 참가자에 그 에이전트가
        // 정말 있는지 재확認(생성 측 드롭 방어·PO CHANGES1).
        if (!conversationId) {
          conversationId = await createFirstInstructionConversation(projectId, agentId);
          if (cancelled) return;
          if (!conversationId) {
            fail();
            return;
          }
          const createdParts = await fetchConversationParticipants(conversationId);
          if (cancelled) return;
          if (!createdParts || !participantsIncludeAgent(createdParts, agentId)) {
            fail();
            return;
          }
        }

        const { path, tooLong } = buildFirstInstructionTarget(conversationId, compose, flags);
        if (tooLong) {
          // compose 없이 재구성 — 새 리터럴 0(같은 함수 재사용, 위 base와 동형).
          setConversationHref(withProjectParam(buildFirstInstructionTarget(conversationId, '', flags).path, conversationProjectId));
          setPhase('too_long');
          return;
        }
        // AC2 — 교체 이동(뒤로가기로 이 중간 주소에 안 돌아옴). 전송은 사람이 대화 화면에서 누른다.
        // story #4231 3차 · 까디르 QA(ccef5258a) — 첫 착지(대화 · flat)는 프로젝트를 싣는다(착지 뒤 셸 ?p= 정규화 왕복 없음) — 그 대화의 프로젝트.
        router.replace(withProjectParam(path, conversationProjectId));
      } catch {
        fail();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [agentId, projectId, compose, router, flags]);

  // 안내 화면의 「목록으로」 폴백 — 목적지 모듈 한 곳(AC3, 파일 안 경로 리터럴 0).
  const chatsListHref = withProjectParam(resolveNavV3Destinations(flags).chats.path, projectId);

  if (phase === 'error') {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-3 px-4 text-center">
        <p className="text-base font-medium">{t('firstInstructionErrorTitle')}</p>
        <p className="text-sm text-muted-foreground">{t('firstInstructionErrorHint')}</p>
        <Link href={chatsListHref} className="text-sm font-medium text-primary underline underline-offset-4">
          {t('firstInstructionOpenList')}
        </Link>
      </main>
    );
  }

  if (phase === 'too_long') {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-3 px-4 text-center">
        <p className="text-base font-medium">{t('firstInstructionTooLongTitle')}</p>
        <p className="text-sm text-muted-foreground">{t('firstInstructionTooLongHint')}</p>
        <Link
          href={conversationHref ?? chatsListHref}
          className="text-sm font-medium text-primary underline underline-offset-4"
        >
          {t('firstInstructionOpenConversation')}
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-4 text-center">
      <p className="text-sm text-muted-foreground">{t('firstInstructionOpening')}</p>
    </main>
  );
}
