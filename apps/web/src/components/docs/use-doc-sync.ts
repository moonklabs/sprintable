import { useState, useEffect, useRef, useCallback, useMemo } from 'react';

export type SaveStatus = 'idle' | 'unsaved' | 'saving' | 'saved' | 'conflict' | 'remote-changed' | 'error';

/**
 * Read the saved doc + its `updated_at` out of a PATCH response, tolerating both
 * shapes the docs endpoint can return. The PATCH route is a raw `proxyToFastapi`
 * passthrough (`/api/docs/[id]/route.ts`), so the live shape is the bare
 * `DocResponse` (`{ updated_at, ... }`) — NOT the legacy enveloped `{ data: {...} }`.
 * Reading `json.data.updated_at` against the raw body threw (`json.data` undefined),
 * which left `save()` un-settled → permanent dirty → infinite autosave + missing
 * baseline → BE 409 protection disarmed → silent overwrite of external edits
 * (fc4d4264 envelope-boundary regression). The `??` keeps this robust if the route
 * is ever re-wrapped with `proxyToFastapiWrapped`.
 */
export function unwrapDocResponse<TDoc>(json: unknown): { doc: TDoc; updatedAt: string | undefined } {
  const root = (json ?? {}) as { data?: { updated_at?: string }; updated_at?: string };
  const doc = (root.data ?? root) as TDoc;
  const updatedAt = root.data?.updated_at ?? root.updated_at;
  return { doc, updatedAt };
}

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
  autosave?: boolean;
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
  autosave = true,
  autosaveDelay = 1500,
  pollInterval = 30_000,
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

    // FIX-2 (fc4d4264): never fire a non-force PATCH without a baseline. A missing
    // `expected_updated_at` disables the BE 409 optimistic-concurrency check, so the
    // save would blindly last-write-wins over a concurrent external/agent edit.
    // Refuse rather than clobber — surface 'error' so the state is visible, not silent.
    if (!isForce && !baselineUpdatedAt) {
      setStatus('error');
      return false;
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
        // BE conflict body: { error: { code: 'DOC_CONFLICT', current_updated_at } }. Adopt the
        // server's current updated_at as the new baseline so an acknowledged retry reconciles
        // against the live version instead of conflicting again (151e05f1 CP2).
        try {
          const conflictBody = await res.json() as { error?: { current_updated_at?: string } };
          const current = conflictBody.error?.current_updated_at;
          if (current) setBaselineUpdatedAt(current);
        } catch { /* malformed conflict body — still surface the conflict */ }
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
      const { doc: savedDoc, updatedAt: nextUpdatedAt } = unwrapDocResponse<TDoc>(json);
      // A response with no `updated_at` cannot establish a baseline — treating it as
      // success would re-arm the exact unguarded-overwrite loop this story fixes, so
      // fail loudly instead of advancing into an undefined baseline.
      if (!nextUpdatedAt) {
        setStatus('error');
        savingRef.current = false;
        return false;
      }
      previousServerUpdatedAtRef.current = nextUpdatedAt;
      conflictRef.current = false;
      remoteChangedRef.current = false;
      setLastSavedSnapshot(nextSnapshot);
      setBaselineUpdatedAt(nextUpdatedAt);
      setStatus('saved');
      onSaved?.(savedDoc);
      savingRef.current = false;
      return true;
    } catch {
      setStatus('error');
      savingRef.current = false;
      return false;
    }
  }, [baselineUpdatedAt, docId, lastSavedSnapshot, onSaved, savePayload]);

  useEffect(() => {
    if (!autosave || !editing || !isDirty || conflictRef.current || remoteChangedRef.current) return;

    const scheduler = createAutosaveScheduler(autosaveDelay);
    scheduler.schedule(() => { void save(); });
    return () => scheduler.cancel();
  }, [autosave, autosaveDelay, currentSnapshot, editing, isDirty, save]);

  useEffect(() => {
    if (!docId || !editing || !baselineUpdatedAt || remoteChangedRef.current || conflictRef.current) return;

    let intervalId: ReturnType<typeof setInterval> | null = null;

    const poll = async () => {
      if (savingRef.current || remoteChangedRef.current || conflictRef.current) return;
      try {
        const res = await fetch(`/api/docs/${docId}/updated-at`);
        if (!res.ok) return;
        const json = await res.json() as { data?: { updated_at?: string } };
        const remoteUpdatedAt = json.data?.updated_at;
        if (!remoteUpdatedAt || remoteUpdatedAt === baselineUpdatedAt) return;
        remoteChangedRef.current = true;
        setStatus('remote-changed');
        onRemoteChange?.(remoteUpdatedAt);
      } catch {
        // polling failures are intentionally silent
      }
    };

    const start = () => {
      if (intervalId) return;
      intervalId = setInterval(() => { void poll(); }, pollInterval);
    };
    const stop = () => {
      if (intervalId) { clearInterval(intervalId); intervalId = null; }
    };
    const handleVisibility = () => { if (document.hidden) { stop(); } else { start(); } };

    start();
    document.addEventListener('visibilitychange', handleVisibility);
    return () => { stop(); document.removeEventListener('visibilitychange', handleVisibility); };
  }, [baselineUpdatedAt, docId, editing, onRemoteChange, pollInterval]);

  return {
    status,
    isDirty,
    save,
    clearSyncAlerts,
  };
}
