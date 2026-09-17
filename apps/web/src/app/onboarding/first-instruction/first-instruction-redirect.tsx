'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { fetchWithAuth } from '@/lib/db/client';
import { createFirstInstructionConversation } from '@/lib/onboarding/first-instruction';

// [SID:4021] compose는 URL 쿼리로 실려 가고, 메시지 content는 서버 스키마(SendMessageRequest.content:
// str·conversation.py content=Text)에 명시 상한이 없다 → «기존 채팅 입력 상한»이 없어 URL-안전 상한을
// 여기서 정한다(과도한 주소 방지). 넘으면 잘라 싣지 않고 안내(AC3).
export const MAX_COMPOSE_LENGTH = 2000;

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

// AC2·PO 보탬1 — «찾기» 우선(POST /api/conversations는 중복 방지가 없어 부를 때마다 새 대화가 쌓인다).
// ① 체크리스트 first_instruction_conversation_id — 단 그 대화 참가자에 이 에이전트가 있을 때만.
// ② 목록에서 나+이 에이전트 DM 최신 1건. 둘 다 없으면 null(→ 생성 1회).
export function pickExistingConversationId(
  checklistId: string | null,
  conversations: ConversationLite[],
  agentId: string,
): string | null {
  const hasAgent = (c: ConversationLite) =>
    (c.participants ?? []).some((p) => p.member_id === agentId);

  if (checklistId) {
    const match = conversations.find((c) => c.id === checklistId);
    if (match && hasAgent(match)) return checklistId;
  }

  const agentDms = conversations
    .filter((c) => c.type === 'dm' && hasAgent(c))
    .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
  return agentDms[0]?.id ?? null;
}

// 대화 화면 목적지. compose 비면 compose 없이, 상한 넘으면 싣지 않고 tooLong 표시(AC3).
export function buildFirstInstructionTarget(
  conversationId: string,
  compose: string,
): { path: string; tooLong: boolean } {
  if (compose.length > MAX_COMPOSE_LENGTH) {
    return { path: `/chats/${conversationId}`, tooLong: true };
  }
  if (compose.length === 0) {
    return { path: `/chats/${conversationId}`, tooLong: false };
  }
  return { path: `/chats/${conversationId}?compose=${encodeURIComponent(compose)}`, tooLong: false };
}

async function fetchChecklistConversationId(): Promise<string | null> {
  try {
    const res = await fetchWithAuth('/api/activation/checklist');
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { first_instruction_conversation_id: string | null } };
    return json.data?.first_instruction_conversation_id ?? null;
  } catch {
    return null;
  }
}

async function fetchAgentConversations(projectId: string): Promise<ConversationLite[]> {
  try {
    const res = await fetchWithAuth(
      `/api/conversations?project_id=${encodeURIComponent(projectId)}&include_agent_conversations=true&limit=50`,
    );
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: ConversationLite[] };
    return json.data ?? [];
  } catch {
    return [];
  }
}

type Phase = 'resolving' | 'error' | 'too_long';

interface FirstInstructionRedirectProps {
  agentId: string | null;
  compose: string;
  projectId: string | null;
}

export function FirstInstructionRedirect({ agentId, compose, projectId }: FirstInstructionRedirectProps) {
  const t = useTranslations('onboarding');
  const router = useRouter();
  // agent·project가 없으면 애초에 할 게 없다 — 렌더 시점에 error로 시작(효과 내 동기 setState 회피).
  const [phase, setPhase] = useState<Phase>(() => (agentId && projectId ? 'resolving' : 'error'));
  // tooLong일 때 compose 없이 열 대화 주소(안내의 「대화 열기」 링크).
  const [conversationHref, setConversationHref] = useState<string | null>(null);
  // AC2·보탬2 — 효과는 마운트당 1회만(StrictMode 이중 호출·새로고침 이중 생성 방지). 생성 자체의
  // 재발 방지는 «찾기»(pickExistingConversationId)가 맡는다.
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return;
    // agent·project 없음은 초기 phase가 이미 'error' — 효과는 조용히 끝낸다(setState 0).
    if (!agentId || !projectId) return;
    ranRef.current = true;

    let cancelled = false;
    (async () => {
      try {
        const [checklistId, conversations] = await Promise.all([
          fetchChecklistConversationId(),
          fetchAgentConversations(projectId),
        ]);
        let conversationId = pickExistingConversationId(checklistId, conversations, agentId);
        if (!conversationId) {
          // ③ 없을 때만 웹이 이미 쓰는 생성 경로(에이전트 지정)로 1회. 다른 org·없는 멤버면 null.
          conversationId = await createFirstInstructionConversation(projectId, agentId);
        }
        if (cancelled) return;
        if (!conversationId) {
          setPhase('error');
          return;
        }
        const { path, tooLong } = buildFirstInstructionTarget(conversationId, compose);
        if (tooLong) {
          setConversationHref(`/chats/${conversationId}`);
          setPhase('too_long');
          return;
        }
        // AC2 — 교체 이동(뒤로가기로 이 중간 주소에 안 돌아옴). 전송은 사람이 대화 화면에서 누른다.
        router.replace(path);
      } catch {
        if (!cancelled) setPhase('error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [agentId, projectId, compose, router]);

  if (phase === 'error') {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-3 px-4 text-center">
        <p className="text-base font-medium">{t('firstInstructionErrorTitle')}</p>
        <p className="text-sm text-muted-foreground">{t('firstInstructionErrorHint')}</p>
        <Link href="/chats" className="text-sm font-medium text-primary underline underline-offset-4">
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
          href={conversationHref ?? '/chats'}
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
