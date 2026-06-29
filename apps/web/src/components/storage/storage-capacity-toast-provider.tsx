'use client';

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { ToastContainer, useToast } from '@/components/ui/toast';

/** 세션 1회 가드 — 같은 세션 새로고침 시 토스트 재노출 방지. */
const TOAST_SHOWN_KEY = 'storage-capacity-toast-shown';

/**
 * S8 — 글로벌 스토리지 용량 session-toast (story 4fbb10c1).
 * /storage 밖에 있는 유저에게도 ≥80% 임박을 앱 로드 1회 알린다(폴링 없음·세션 1회).
 * 토스트는 정보 전용(액션 링크 미지원 — addToast 는 {title, body?, type} 만) → CTA 는 배너가 담당.
 * 100%+ 는 destructive 톤(type='error')으로 "업로드 중단" 고지.
 */
export function StorageCapacityToastProvider({ children }: { children: React.ReactNode }) {
  const t = useTranslations('storage');
  const { orgId } = useDashboardContext();
  const { toasts, addToast, dismissToast } = useToast();
  const ranRef = useRef(false);

  useEffect(() => {
    // 인증 컨텍스트 준비(orgId) + 세션 1회만.
    if (!orgId || ranRef.current) return;
    try {
      if (sessionStorage.getItem(TOAST_SHOWN_KEY) === '1') {
        ranRef.current = true;
        return;
      }
    } catch {
      // sessionStorage 불가 — 가드 없이 1회 진행
    }
    ranRef.current = true;

    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/assets/storage-usage');
        if (!res.ok) return;
        const json = (await res.json()) as { data?: { percentage?: number } };
        const pct = json.data?.percentage;
        // 유한수 가드 — limit_bytes 0/null(무제한) → NaN/Infinity 가능(div0 방어). NaN<80=false 회피.
        if (cancelled || typeof pct !== 'number' || !Number.isFinite(pct) || pct < 80) return;
        const roundedPct = Math.round(pct);
        const isBlock = pct >= 100;
        addToast({
          type: isBlock ? 'error' : 'warning',
          title: t('capacityToastTitle', { pct: roundedPct }),
          body: isBlock ? t('capacityToastDescBlock') : t('capacityToastDesc'),
        });
        try {
          sessionStorage.setItem(TOAST_SHOWN_KEY, '1');
        } catch {
          // 영속 실패 무시
        }
      } catch {
        // 조회 실패는 치명적이지 않음 — 토스트 미노출
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, addToast, t]);

  return (
    <>
      {children}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}
