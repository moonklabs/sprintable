'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, ShieldCheck, Clock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ToastContainer, useToast } from '@/components/ui/toast';

/**
 * E-DG RC#2 ⓶ — epic status-transition 컨트롤(상세 헤더). status badge + 유효 next-state만 dropdown
 * → POST /api/goals/{id}/transition. FSM 유효 전이만 노출(invalid 미노출·"보이는=실행가능").
 *
 * story #2013(2026-07-19, 선생님 draft→active 차단 재보고): 8fc51517이 그때는 옳게(POST .../transition이
 * 존재한 적 없어 PATCH로 교정)했으나, 이후 E-DG S25가 POST .../transition을 신설하며 동시에 generic
 * PATCH의 status 변경을 422로 막았음(routers/goals.py:297) — FE만 옛 경로에 남아 시차 드리프트,
 * 클릭해도 무반응(422 삼킴)이었던 것을 이번에 POST 경로 교체 + 에러 표면화로 근본 수정.
 * 형제표면 steer-dispatch/route.ts와 동일 근거로 proxyToFastapiWrapped 사용(구조화 에러 보존).
 *
 * ⭐draft→active·active→done은 human/aggregate-gate(overlay)라 enforcing 시 gate 생성·status 유지 →
 * 낙관적 반영 X·반환 status가 target과 다르면(미변경) "승인 대기"(gate pending) 표시(PO note②·S24 gate 어휘).
 * BE _EPIC_VALID_TRANSITIONS 미러. 신규 토큰 0(ChevronDown/ShieldCheck/Clock).
 */
const VALID_NEXT: Record<string, string[]> = {
  draft: ['active', 'archived'],
  active: ['done', 'archived'],
  done: ['archived'],
  archived: [],
};
// overlay-gated 전이(human/aggregate gate 거침) — dropdown item에 gate 표식.
const GATED = new Set(['draft>active', 'active>done']);
const LABEL_KEY: Record<string, string> = {
  draft: 'statusDraft',
  active: 'statusActive',
  done: 'statusDone',
  archived: 'statusArchived',
};
const VARIANT: Record<string, 'secondary' | 'info' | 'success' | 'outline'> = {
  draft: 'secondary',
  active: 'info',
  done: 'success',
  archived: 'secondary',
};

export function EpicStatusTransition({
  epicId,
  status,
  onTransitioned,
}: {
  epicId: string;
  status: string;
  onTransitioned: (newStatus: string) => void;
}) {
  const t = useTranslations('goals');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(false); // gate 생성·승인 대기(status 미변경)
  const { toasts, addToast, dismissToast } = useToast();

  const nexts = VALID_NEXT[status] ?? [];

  const transition = async (to: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/goals/${epicId}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: to }),
      });
      const json = (await res.json()) as {
        data?: { status?: string };
        error?: { code?: string; message?: string };
      };
      if (!res.ok) {
        // story #2013: 무반응이 이 버그의 본체 — 거부 사유(HUMAN_CONFIRM_REQUIRED·
        // INVALID_EPIC_TRANSITION 등)를 그대로 화면에 띄운다(삼키지 않음).
        addToast({
          type: 'error',
          title: t('transitionFailedTitle'),
          body: json?.error?.message || t('transitionFailedFallback'),
        });
        return;
      }
      const returned = json?.data?.status;
      if (returned === to) {
        setPending(false);
        onTransitioned(to); // 즉시 전이(gate 없음 or default-off inline)
      } else {
        // enforcing gate 생성 → status 유지·승인 대기(낙관적 반영 X·PO note②)
        setPending(true);
      }
    } catch {
      addToast({ type: 'error', title: t('transitionFailedTitle'), body: t('transitionFailedFallback') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-1.5">
      <Badge variant={VARIANT[status] ?? 'secondary'}>{t(LABEL_KEY[status] ?? 'statusDraft')}</Badge>
      {pending ? (
        <Badge variant="warning" className="gap-1">
          <Clock className="size-3 shrink-0" />
          {t('transitionPending')}
        </Badge>
      ) : null}
      {nexts.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={t('transitionAction')}
            disabled={busy}
            className="inline-flex items-center gap-0.5 rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            {t('transitionAction')}
            <ChevronDown className="size-3 shrink-0" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {nexts.map((to) => (
              <DropdownMenuItem key={to} disabled={busy} onClick={() => void transition(to)}>
                {t(LABEL_KEY[to] ?? to)}
                {GATED.has(`${status}>${to}`) ? (
                  <span className="ml-2 inline-flex items-center gap-0.5 text-[10px] text-warning" title={t('transitionGateHint')}>
                    <ShieldCheck className="size-3 shrink-0" />
                  </span>
                ) : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
