'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { ToastContainer, useToast } from '@/components/ui/toast';

// story #2168 PR-② 후속(라이브 실측으로 발견) — chat-list-view.tsx가 "다른 프로젝트" 항목
// 클릭 시 addToast를 호출한 바로 다음 줄에서 router.push로 상세 페이지(다른 라우트)로 이동한다.
// 그 즉시 ChatListView 자체가 언마운트되며 로컬 useToast()/ToastContainer도 함께 사라져,
// 토스트가 화면에 페인트될 기회조차 없이 사라졌다 — 클릭 직후 동기 체크(DOM querySelector)로도
// 토스트 컨테이너가 안 잡혔다. storage-capacity-toast-provider.tsx와 같은 패턴(네비게이션을
// 넘어 살아남는 (authenticated) layout 레벨 provider)으로 옮긴다 — 새 패턴을 만들지 않고
// 기존에 이미 검증된 것을 재사용.
const PENDING_TOAST_KEY = 'sprintable_pending_toast';

/** 네비게이션 직전에 호출 — 도착한 페이지에서 CrossProjectToastProvider가 이 값을 읽어 띄운다. */
export function queuePendingToast(title: string): void {
  try {
    sessionStorage.setItem(PENDING_TOAST_KEY, title);
  } catch {
    // sessionStorage 불가 — 토스트 없이 진행(전환 자체는 이미 일어나므로 치명적이지 않음)
  }
}

export function CrossProjectToastProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { toasts, addToast, dismissToast } = useToast();
  const consumedRef = useRef<string | null>(null);

  // pathname이 바뀔 때마다(=네비게이션 도착마다) 대기 중인 토스트가 있는지 확인한다.
  // 이 provider 자체는 언마운트되지 않으므로(layout 레벨 상주) 매 도착에서 반드시 체크된다.
  useEffect(() => {
    let pending: string | null = null;
    try {
      pending = sessionStorage.getItem(PENDING_TOAST_KEY);
    } catch {
      // ignore
    }
    if (!pending || consumedRef.current === pending) return;
    consumedRef.current = pending;
    try {
      sessionStorage.removeItem(PENDING_TOAST_KEY);
    } catch {
      // ignore
    }
    addToast({ title: pending, type: 'info' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  return (
    <>
      {children}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}
