'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';

export interface ToastItem {
  id: string;
  title: string;
  body?: string;
  type?: 'info' | 'warning' | 'success' | 'error';
  isHighlight?: boolean;
}

interface ToastProps {
  item: ToastItem;
  onDismiss: (id: string) => void;
}

function Toast({ item, onDismiss }: ToastProps) {
  const t = useTranslations('common');
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(item.id), 5000);
    return () => clearTimeout(timer);
  }, [item.id, onDismiss]);

  const borderColor = item.isHighlight
    ? 'border-l-4 border-l-brand'
    : item.type === 'success'
      ? 'border-l-4 border-l-success'
      : item.type === 'warning'
        ? 'border-l-4 border-l-warning'
        : item.type === 'error'
          ? 'border-l-4 border-l-destructive'
          : item.type === 'info'
            ? 'border-l-4 border-l-info'
            : 'border-l-4 border-l-border';

  // story #2096 — 토스트는 조작 결과(담당자 지정 성공 등)를 알리는 유일한 수단인 경우가
  // 많은데 role·aria-live가 없어 스크린리더가 아예 안 읽었다(까심군이 #2384 검수 때 자동으로
  // 못 잡고 스크린샷으로만 확認한 원인). AC2 — error는 사용자가 지금 막힌 상태이므로 다른
  // 작업을 끊고서라도 즉시 알려야 한다(role="alert" → 암묵적 aria-live="assertive"). 나머지
  // (success/info/warning)는 결과 보고일 뿐 흐름을 끊을 만큼 급하지 않다(role="status" →
  // 암묵적 aria-live="polite", 진행 중이던 스크린리더 낭독이 끝난 뒤 자연스럽게 이어 읽는다).
  // aria-live/aria-atomic은 role의 암묵값과 같은 값을 명시로 중복 기술한다 — role의 암묵
  // 라이브리전 매핑을 지원 안 하는 스크린리더/자동화 도구 대비.
  const isUrgent = item.type === 'error';

  return (
    <div
      role={isUrgent ? 'alert' : 'status'}
      aria-live={isUrgent ? 'assertive' : 'polite'}
      aria-atomic="true"
      className={`animate-slide-in rounded-lg border border-border bg-popover p-4 shadow-lg ${borderColor}`}
    >
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-semibold text-popover-foreground">{item.title}</p>
          {item.body && (
            <p className="mt-1 text-xs text-muted-foreground">{item.body}</p>
          )}
        </div>
        <button
          onClick={() => onDismiss(item.id)}
          aria-label={t('close')}
          className="ml-3 text-muted-foreground hover:text-foreground"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

export function useToast() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const addToast = useCallback((toast: Omit<ToastItem, 'id'>) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setToasts((prev) => [...prev.slice(-4), { ...toast, id }]);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return { toasts, addToast, dismissToast };
}

export function ToastContainer({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}) {
  if (toasts.length === 0) return null;

  return (
    <div className="fixed right-4 z-50 flex flex-col gap-2" style={{ bottom: 'max(1rem, calc(env(safe-area-inset-bottom) + 1rem))' }}>
      {toasts.map((t) => (
        <Toast key={t.id} item={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
