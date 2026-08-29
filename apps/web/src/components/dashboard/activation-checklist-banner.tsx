'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronUp, Circle, CircleCheck, Loader2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { fetchWithAuth } from '@/lib/db/client';
import { createFirstInstructionConversation } from '@/lib/onboarding/first-instruction';
import { cn } from '@/lib/utils';

/**
 * story #3159(retention·최소층) — 가입 후 남은 activation 단계를 상시 노출(완주 유도).
 * `/api/activation/checklist` 마운트 1회 조회(storage-capacity-banner.tsx와 동형 no-polling
 * 패턴). PO 지시(2026-08-27): 완전 소멸은 완주(all_complete) 시만 — 접기(collapse)는
 * 허용하되 접힌 상태에서도 진행률 칩은 남는다(수동 dismiss로 완전히 숨길 순 없음).
 *
 * 완주를 한 번 관측하면 localStorage에 영구 기록해 이후 세션은 fetch 자체를 건너뛴다
 * (activation은 단조 증가 — 한 번 다 채우면 되돌아가지 않는다. 활성 사용자 전원이 매
 * 세션 이 엔드포인트를 다시 때리는 낭비 방지).
 */
const COMPLETE_KEY = 'sprintable_activation_checklist_complete';
const COLLAPSE_KEY = 'sprintable_activation_checklist_collapsed';

interface ActivationState {
  steps: {
    signed_up: boolean;
    email_verified: boolean;
    org_created: boolean;
    agent_connected: boolean;
    first_roundtrip: boolean;
  };
  completed: number;
  total: number;
  all_complete: boolean;
  // story #3201 — 왕복 성사된 대화(또는 org 최초 agent DM) id, 없으면 null.
  first_instruction_conversation_id: string | null;
}

function readLocalFlag(key: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

export function ActivationChecklistBanner() {
  const t = useTranslations('activation');
  const router = useRouter();
  const { projectId } = useDashboardContext();
  const [state, setState] = useState<ActivationState | null>(null);
  const [skip] = useState<boolean>(() => readLocalFlag(COMPLETE_KEY));
  const [navigatingToInstruction, setNavigatingToInstruction] = useState(false);
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      return window.sessionStorage.getItem(COLLAPSE_KEY) === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (skip) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchWithAuth('/api/activation/checklist');
        if (!res.ok) return;
        const json = (await res.json()) as { data?: ActivationState };
        if (cancelled || !json.data) return;
        setState(json.data);
        if (json.data.all_complete) {
          try {
            window.localStorage.setItem(COMPLETE_KEY, '1');
          } catch {
            // 영속 실패해도 이번 렌더는 정상 동작(단지 다음 세션에 한 번 더 조회할 뿐)
          }
        }
      } catch {
        // 조회 실패는 치명적이지 않음 — 배너 미노출
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [skip]);

  if (skip || !state || state.all_complete) return null;

  const toggleCollapse = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      window.sessionStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
    } catch {
      // 영속 실패해도 이번 렌더는 토글 반영
    }
  };

  // story #3201(AC2) — "첫 지시…" 항목만 클릭 가능(전 항목 클릭화는 범위 밖·#3196 잔존分
  // 그대로). PO 확定 우선순위: BE first_instruction_conversation_id 있으면 그대로 이동,
  // 없으면 connect-step CTA와 동일한 신규 DM 생성 경로 재사용(제3경로 발명 금지).
  const handleFirstInstructionClick = async () => {
    if (navigatingToInstruction) return;
    if (state?.first_instruction_conversation_id) {
      router.push(`/chats/${state.first_instruction_conversation_id}`);
      return;
    }
    if (!projectId) return;
    setNavigatingToInstruction(true);
    try {
      const convId = await createFirstInstructionConversation(projectId);
      if (convId) router.push(`/chats/${convId}`);
    } finally {
      setNavigatingToInstruction(false);
    }
  };

  const stepItems: { key: keyof ActivationState['steps']; label: string }[] = [
    { key: 'email_verified', label: t('stepEmailVerified') },
    { key: 'org_created', label: t('stepOrgCreated') },
    { key: 'agent_connected', label: t('stepAgentConnected') },
    { key: 'first_roundtrip', label: t('stepFirstRoundtrip') },
  ];

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={toggleCollapse}
        aria-expanded={false}
        aria-label={t('expandAria')}
        className="flex w-full items-center justify-between gap-2 rounded-lg border border-border bg-muted/50 px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
      >
        <span>{t('collapsedChip', { completed: state.completed, total: state.total })}</span>
        <ChevronDown className="size-3.5 shrink-0" />
      </button>
    );
  }

  return (
    <Alert variant="info" className="relative">
      <AlertTitle>{t('bannerTitle')}</AlertTitle>
      <AlertDescription>{t('bannerProgress', { completed: state.completed, total: state.total })}</AlertDescription>

      <ul className="col-start-2 mt-2 space-y-1.5">
        {stepItems.map(({ key, label }) => {
          const met = state.steps[key];
          // story #3181 — met 항목은 text-foreground. text-success(#1F9D57 계열색)는 info Alert의
          // blue-soft(#EAEEFF) 배경 위에서 대비 미달(≈2.8:1<4.5·axe color-contrast 신규 위반). #2420
          // 규율(tint 위 계열색 글자는 text-foreground)·완료 여부는 CircleCheck vs Circle 모양이 전달하므로
          // 색 의존을 제거해도 신호 손실 0(색맹 접근성↑). 아이콘도 li 색 상속으로 함께 정리.
          const icon = met ? <CircleCheck className="size-3.5 shrink-0" /> : <Circle className="size-3.5 shrink-0" />;
          // story #3201(AC2) — "첫 지시…" 항목만 클릭 가능(해당 대화로 이동). 다른 항목은
          // 기존 그대로 비-인터랙티브 li(스코프 밖, #3196 잔존分).
          if (key === 'first_roundtrip') {
            return (
              <li key={key}>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => void handleFirstInstructionClick()}
                  disabled={navigatingToInstruction || !projectId}
                  className={cn(
                    'h-auto w-full min-w-0 justify-start gap-1.5 rounded px-1 py-0.5 text-left text-sm font-normal hover:underline disabled:no-underline',
                    met ? 'text-foreground' : 'text-muted-foreground',
                  )}
                >
                  {navigatingToInstruction ? <Loader2 className="size-3.5 shrink-0 animate-spin" /> : icon}
                  <span>{label}</span>
                </Button>
              </li>
            );
          }
          return (
            <li key={key} className={cn('flex items-center gap-1.5 text-sm', met ? 'text-foreground' : 'text-muted-foreground')}>
              {icon}
              <span>{label}</span>
            </li>
          );
        })}
      </ul>

      <Button
        variant="ghost"
        size="icon-sm"
        className="absolute right-2 top-2"
        aria-label={t('collapseAria')}
        aria-expanded={true}
        onClick={toggleCollapse}
      >
        <ChevronUp className="size-4" />
      </Button>
    </Alert>
  );
}
