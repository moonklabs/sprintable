import { useState, useEffect, useRef, useCallback, useMemo } from 'react';

export type SaveStatus = 'idle' | 'unsaved' | 'saving' | 'saved' | 'conflict' | 'remote-changed' | 'error';

/**
 * Pure debounce scheduler — exported for unit tests.
 * Each `schedule(fn)` cancels the previous pending call so rapid invocations
 * coalesce into a single execution after `delay` ms.
 */
export function createAutosaveScheduler(delay: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;

  return {
    schedule(fn: () => void): void {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fn();
      }, delay);
    },
    cancel(): void {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

interface UseDocSyncOptions<TDoc = { updated_at: string }> {
  docId: string | null;
  savePayload: Record<string, unknown>;
  snapshotKey?: string;
  serverUpdatedAt: string | null;
  editing: boolean;
  autosaveDelay?: number;
  pollInterval?: number;
  onSaved?: (doc: TDoc) => void;
  onRemoteChange?: (serverUpdatedAt: string) => void;
}

export function useDocSync<TDoc = { updated_at: string }>({
  docId,
  savePayload,
  snapshotKey,
  serverUpdatedAt,
  editing,
  autosaveDelay = 1500,
  pollInterval = 10_000,
  onSaved,
  onRemoteChange,
}: UseDocSyncOptions<TDoc>) {
  const currentSnapshot = useMemo(() => snapshotKey ?? JSON.stringify(savePayload), [savePayload, snapshotKey]);
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [lastSavedSnapshot, setLastSavedSnapshot] = useState(currentSnapshot);
  const [baselineUpdatedAt, setBaselineUpdatedAt] = useState(serverUpdatedAt);

  const previousDocIdRef = useRef(docId);
  const previousServerUpdatedAtRef = useRef(serverUpdatedAt);
  const savingRef = useRef(false);
  const conflictRef = useRef(false);
  const remoteChangedRef = useRef(false);

  const clearSyncAlerts = useCallback((nextStatus: SaveStatus = 'saved') => {
    conflictRef.current = false;
    remoteChangedRef.current = false;
    setStatus(nextStatus);
  }, []);

  useEffect(() => {
    if (previousDocIdRef.current === docId) return;

    previousDocIdRef.current = docId;
    previousServerUpdatedAtRef.current = serverUpdatedAt;
    conflictRef.current = false;
    remoteChangedRef.current = false;

    const timer = window.setTimeout(() => {
      setLastSavedSnapshot(currentSnapshot);
      setBaselineUpdatedAt(serverUpdatedAt);
      setStatus('idle');
    }, 0);

    return () => window.clearTimeout(timer);
  }, [currentSnapshot, docId, serverUpdatedAt]);

  useEffect(() => {
    if (!serverUpdatedAt || serverUpdatedAt === previousServerUpdatedAtRef.current) return;

    previousServerUpdatedAtRef.current = serverUpdatedAt;
    conflictRef.current = false;
    remoteChangedRef.current = false;

    const timer = window.setTimeout(() => {
      setLastSavedSnapshot(currentSnapshot);
      setBaselineUpdatedAt(serverUpdatedAt);
      setStatus(editing ? 'saved' : 'idle');
    }, 0);

    return () => window.clearTimeout(timer);
  }, [currentSnapshot, editing, serverUpdatedAt]);

  const isDirty = editing && currentSnapshot !== lastSavedSnapshot;

  useEffect(() => {
    if (!editing || savingRef.current || conflictRef.current || remoteChangedRef.current || !isDirty) return;

    const timer = window.setTimeout(() => {
      setStatus('unsaved');
    }, 0);

    return () => window.clearTimeout(timer);
  }, [editing, isDirty]);

  const save = useCallback(async (options?: { force?: boolean; payloadOverride?: Record<string, unknown> }) => {
    if (!docId || savingRef.current) return false;

    const nextPayload = options?.payloadOverride ? { ...savePayload, ...options.payloadOverride } : savePayload;
    const nextSnapshot = JSON.stringify(nextPayload);
    const isForce = options?.force ?? false;

    if ((conflictRef.current || remoteChangedRef.current) && !isForce) {
      setStatus(conflictRef.current ? 'conflict' : 'remote-changed');
      return false;
    }

    if (nextSnapshot === lastSavedSnapshot && !isForce) {
      setStatus('saved');
      return true;
    }

    savingRef.current = true;
    setStatus('saving');

    try {
      const res = await fetch(`/api/docs/${docId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...nextPayload,
          expected_updated_at: isForce ? undefined : baselineUpdatedAt ?? undefined,
          force_overwrite: isForce || undefined,
        }),
      });

      if (res.status === 409) {
        conflictRef.current = true;
        remoteChangedRef.current = false;
        setStatus('conflict');
        savingRef.current = false;
        return false;
      }

      if (!res.ok) {
        setStatus('error');
        savingRef.current = false;
        return false;
      }

      const json = await res.json();
      const nextUpdatedAt = json.data.updated_at as string;
      previousServerUpdatedAtRef.current = nextUpdatedAt;
      conflictRef.current = false;
      remoteChangedRef.current = false;
      setLastSavedSnapshot(nextSnapshot);
      setBaselineUpdatedAt(nextUpdatedAt);
      setStatus('saved');
      onSaved?.(json.data as TDoc);
      savingRef.current = false;
      return true;
    } catch {
      setStatus('error');
      savingRef.current = false;
      return false;
    }
  }, [baselineUpdatedAt, docId, lastSavedSnapshot, onSaved, savePayload]);

  useEffect(() => {
    if (!editing || !isDirty || conflictRef.current || remoteChangedRef.current) return;

    const scheduler = createAutosaveScheduler(autosaveDelay);
    scheduler.schedule(() => { void save(); });
    return () => scheduler.cancel();
  }, [autosaveDelay, currentSnapshot, editing, isDirty, save]);

  useEffect(() => {
    if (!docId || !editing || !baselineUpdatedAt || remoteChangedRef.current || conflictRef.current) return;

    const interval = window.setInterval(async () => {
      if (savingRef.current) return;

      try {
        const res = await fetch(`/api/docs/${docId}`);
        if (!res.ok) return;

        const json = await res.json();
        const remoteUpdatedAt = json.data?.updated_at as string | undefined;

        if (!remoteUpdatedAt || remoteUpdatedAt === baselineUpdatedAt) return;

        remoteChangedRef.current = true;
        setStatus('remote-changed');
        onRemoteChange?.(remoteUpdatedAt);
      } catch {
        // polling failures are intentionally silent
      }
    }, pollInterval);

    return () => window.clearInterval(interval);
  }, [baselineUpdatedAt, docId, editing, onRemoteChange, pollInterval]);

  return {
    status,
    isDirty,
    save,
    clearSyncAlerts,
  };
}
