'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronUp, Circle, CircleCheck } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { fetchWithAuth } from '@/lib/db/client';
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
  const [state, setState] = useState<ActivationState | null>(null);
  const [skip] = useState<boolean>(() => readLocalFlag(COMPLETE_KEY));
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
          return (
            <li key={key} className={cn('flex items-center gap-1.5 text-sm', met ? 'text-success' : 'text-muted-foreground')}>
              {met ? <CircleCheck className="size-3.5 shrink-0" /> : <Circle className="size-3.5 shrink-0" />}
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
