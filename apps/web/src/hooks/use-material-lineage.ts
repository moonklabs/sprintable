'use client';

import { useCallback, useEffect, useState } from 'react';
import { fetchWithAuth } from '@/lib/db/client';
import type { MaterialLineageEdge } from '@/services/material-lineage';

// story #4063(E-RECIPE-1 ④ 렌더, PR #4434 위) — GET /api/v2/material-lineage?work_item_id=
// 페칭. #4059(useWorkItemProductionEvidence)와 같은 결: state+loading/loadFailed+refresh.
const MATERIAL_LINEAGE_API_PATH = '/api/v2/material-lineage';

export interface UseMaterialLineageResult {
  edges: MaterialLineageEdge[];
  loading: boolean;
  loadFailed: boolean;
  refresh: () => void;
}

export function useMaterialLineage(workItemId: string | null): UseMaterialLineageResult {
  const [edges, setEdges] = useState<MaterialLineageEdge[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!workItemId) {
      setEdges([]);
      setLoadFailed(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadFailed(false);
    void (async () => {
      try {
        const params = new URLSearchParams({ work_item_id: workItemId });
        const res = await fetchWithAuth(`${MATERIAL_LINEAGE_API_PATH}?${params.toString()}`);
        if (!res.ok) throw new Error(`status ${res.status}`);
        const json = (await res.json()) as MaterialLineageEdge[];
        if (cancelled) return;
        setEdges(Array.isArray(json) ? json : []);
      } catch {
        if (cancelled) return;
        setEdges([]);
        setLoadFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [workItemId, nonce]);

  return { edges, loading, loadFailed, refresh };
}
