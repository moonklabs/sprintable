'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

const STORAGE_KEY = 'sprintable:refresh_interval_ms';
export const DEFAULT_INTERVAL_MS = 30_000;

export const INTERVAL_OPTIONS = [
  { labelKey: 'refreshOff', value: 0 },
  { labelKey: 'refresh15s', value: 15_000 },
  { labelKey: 'refresh30s', value: 30_000 },
  { labelKey: 'refresh1min', value: 60_000 },
  { labelKey: 'refresh5min', value: 300_000 },
] as const;

interface RefreshContextValue {
  intervalMs: number;
  setIntervalMs: (ms: number) => void;
  register: (key: string, fn: () => void) => void;
  unregister: (key: string) => void;
}

const RefreshContext = createContext<RefreshContextValue | null>(null);

function readStoredInterval(): number {
  if (typeof window === 'undefined') return DEFAULT_INTERVAL_MS;
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) return DEFAULT_INTERVAL_MS;
  const parsed = Number(stored);
  return Number.isFinite(parsed) ? parsed : DEFAULT_INTERVAL_MS;
}

export function RefreshProvider({ children }: { children: React.ReactNode }) {
  const [intervalMs, setIntervalMsState] = useState(readStoredInterval);
  const registryRef = useRef(new Map<string, () => void>());

  const setIntervalMs = useCallback((ms: number) => {
    setIntervalMsState(ms);
    localStorage.setItem(STORAGE_KEY, String(ms));
  }, []);

  const register = useCallback((key: string, fn: () => void) => {
    registryRef.current.set(key, fn);
  }, []);

  const unregister = useCallback((key: string) => {
    registryRef.current.delete(key);
  }, []);

  useEffect(() => {
    if (intervalMs === 0) return;
    const id = setInterval(() => {
      registryRef.current.forEach((fn) => fn());
    }, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return (
    <RefreshContext.Provider value={{ intervalMs, setIntervalMs, register, unregister }}>
      {children}
    </RefreshContext.Provider>
  );
}

export function useRefreshContext(): RefreshContextValue {
  const ctx = useContext(RefreshContext);
  if (!ctx) throw new Error('useRefreshContext must be used within RefreshProvider');
  return ctx;
}
