import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { fetchWithAuth } from '@/lib/db/client';

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
  // story #4339(AC7) — 기준선이 어느 문서의 것인지. 문서가 바뀐 뒤 기준선이 잡히기 전(아래 setTimeout 0 한 틱)엔 새 내용을 옛 기준선과
  // 비교해 dirty가 됐다 → 'unsaved' 예약 · 자동 저장 예약(기준선 없이 부르면 FIX-2가 거절해 'error'). 그 틱은 dirty가 아니다.
  const [baselineDocId, setBaselineDocId] = useState(docId);

  const previousDocIdRef = useRef(docId);
  const previousServerUpdatedAtRef = useRef(serverUpdatedAt);
  const savingRef = useRef(false);
  const conflictRef = useRef(false);
  const remoteChangedRef = useRef(false);

  // Mirror currentSnapshot into a ref so the baseline-reset effects below can read the
  // latest snapshot WITHOUT listing currentSnapshot in their deps. With it in the deps,
  // content churn (e.g. a non-idempotent load round-trip) re-ran the effect, its cleanup
  // cancelled the pending setTimeout, and the docId/serverUpdatedAt guard then blocked
  // rescheduling → baselineUpdatedAt stuck null → every save refused by FIX-2. The
  // markdown trigger is gone (FIX-3/3b), but the baseline-set must not be cancellable by
  // content at all (story 2a72ebf4 baseline race).
  const currentSnapshotRef = useRef(currentSnapshot);
  useEffect(() => { currentSnapshotRef.current = currentSnapshot; }, [currentSnapshot]);

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
      setLastSavedSnapshot(currentSnapshotRef.current);
      setBaselineUpdatedAt(serverUpdatedAt);
      setBaselineDocId(docId);
      setStatus('idle');
    }, 0);

    return () => window.clearTimeout(timer);
  }, [docId, serverUpdatedAt]);

  useEffect(() => {
    if (!serverUpdatedAt || serverUpdatedAt === previousServerUpdatedAtRef.current) return;

    previousServerUpdatedAtRef.current = serverUpdatedAt;
    conflictRef.current = false;
    remoteChangedRef.current = false;

    const timer = window.setTimeout(() => {
      setLastSavedSnapshot(currentSnapshotRef.current);
      setBaselineUpdatedAt(serverUpdatedAt);
      setStatus(editing ? 'saved' : 'idle');
    }, 0);

    return () => window.clearTimeout(timer);
  }, [editing, serverUpdatedAt]);

  const isDirty = editing && baselineDocId === docId && currentSnapshot !== lastSavedSnapshot;
  const isDirtyRef = useRef(isDirty);
  useEffect(() => { isDirtyRef.current = isDirty; }, [isDirty]);
  const savePayloadRef = useRef(savePayload);
  useEffect(() => { savePayloadRef.current = savePayload; }, [savePayload]);
  const docIdRef = useRef(docId);
  useEffect(() => { docIdRef.current = docId; }, [docId]);

  // story #4339(AC7 · 유나 실측) — 깨끗한 기준 = 편집기가 이 문서를 연 뒤 처음 다듬은 직렬화. 저장된 문자열을 기준으로 두면(API로 만든
  // 문서처럼 편집기 출력과 모양이 다른 본문) 한 글자 쓰고 지워도 영원히 dirty였다. 편집기가 편집 없이 다듬을 때(onNormalize) 그 값을
  // 기준으로 삼는다 — 쓰기 없음. 이미 dirty(사용자가 입력 중)면 건드리지 않는다.
  const adoptNormalized = useCallback((override: Record<string, unknown>) => {
    if (isDirtyRef.current) return;
    setLastSavedSnapshot(JSON.stringify({ ...savePayloadRef.current, ...override }));
  }, []);

  useEffect(() => {
    if (!editing || savingRef.current || conflictRef.current || remoteChangedRef.current || !isDirty) return;

    const timer = window.setTimeout(() => {
      setStatus('unsaved');
    }, 0);

    return () => window.clearTimeout(timer);
  }, [editing, isDirty]);

  // story #4339(AC7) — 'unsaved'는 dirty일 때만 참이다. 위 타이머는 dirty가 풀려도(기준선이 같은 틱에 잡힘 · 입력했다가 되돌림)
  // 이미 예약된 채 실행돼 «저장 표시 변경사항 있음 + 저장 버튼 바뀐 것 없음»을 남겼다 → dirty가 아니면 dirty 직전 상태로 되돌린다.
  const settledStatusRef = useRef<SaveStatus>('idle');
  useEffect(() => {
    if (status === 'idle' || status === 'saved') settledStatusRef.current = status;
    if (status === 'unsaved' && !isDirty) setStatus(settledStatusRef.current);
  }, [isDirty, status]);

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
    // story #4339(까디르) — 응답이 늦게 와서 그 사이 다른 문서로 옮겼으면 이 응답은 앞 문서 몫이다: 새 문서의 기준선 · updated_at ·
    // onSaved를 덮지 않는다(새 문서가 dirty로 잘못 뜨거나 옛 동시성 기준으로 PATCH하던 자리).
    const requestDocId = docId;
    const stillSameDoc = () => docIdRef.current === requestDocId;

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

      if (!stillSameDoc()) {
        savingRef.current = false;
        return false;
      }
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
      if (!stillSameDoc()) {
        savingRef.current = false;
        return false;
      }
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
        const res = await fetchWithAuth(`/api/docs/${docId}/updated-at`);
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
    adoptNormalized,
  };
}
