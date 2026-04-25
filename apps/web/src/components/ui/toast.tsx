'use client';

import { useState, useEffect, useCallback } from 'react';

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
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(item.id), 5000);
    return () => clearTimeout(timer);
  }, [item.id, onDismiss]);

  const borderColor = item.isHighlight
    ? 'border-l-4 border-l-primary'
    : 'border-l-4 border-l-border';

  return (
    <div className={`animate-slide-in rounded-lg border border-border bg-popover p-4 shadow-lg ${borderColor}`}>
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-semibold text-popover-foreground">{item.title}</p>
          {item.body && (
            <p className="mt-1 text-xs text-muted-foreground">{item.body}</p>
          )}
        </div>
        <button
          onClick={() => onDismiss(item.id)}
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
