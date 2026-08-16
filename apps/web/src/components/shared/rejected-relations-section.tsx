'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { formatRelativeTime } from '@/lib/storage/format';
import { fetchWithAuth } from '@/lib/db/client';

export interface RejectedRelationItem {
  id: string;
  target_type: string;
  target_id: string;
  reason: string | null;
  rejected_by: string | null;
  rejected_at: string;
}

interface RowState {
  item: RejectedRelationItem;
  title: string | null;
  restoring: boolean;
  error: string | null;
  /** AC6 — 되돌린 뒤 화면이 그 사실을 말해야 한다("다시 후보로 올라올 수 있습니다"). 목록에서
   * 조용히 지우면(토스트와 같은 실패 모드 — 사실이 사라진다) 그 말을 할 자리가 없어진다. */
  restored: boolean;
}

type LoadState = { kind: 'loading' } | { kind: 'failed' } | { kind: 'ready'; rows: RowState[] };

/**
 * story #2357 — 기각한 관계 목록 + 되살리기. `GET .../rejected-relations`(story #2357
 * doc `flow-port-slot-spec` ㉣, "되살리기 UI용")를 여기서 처음 소비한다(지금까지 FE
 * 소비처 0건이었다). EntityBacklinksSection과 같은 자리·같은 스타일 관례(스토리 상세
 * 패널에 붙는 자체-fetch 섹션)를 그대로 따른다 — 새 패턴을 만들지 않는다.
 *
 * ⛔AC4 — 목록이 빈 경우 이 섹션 자체를 안 그린다(EntityBacklinksSection과 다른 점 —
 * 그쪽은 "왜 비어 있는지" scope를 설명해야 해서 빈 상태 문구가 있지만, 기각 목록은 설명할
 * scope가 없고 «상시 빈 상자»를 만들면 잡음이 된다는 것이 doc의 명시 판정이다).
 *
 * ⛔토스트 금지(㉣) — 되살리기 액션과 그 결과(성공/실패)는 이 목록 행 «그 자리»에 남는다.
 * ⛔되살린 뒤 "다음 스토리 저장에서 다시 후보로 오를 수 있습니다"까지만 말한다 — "곧 다시
 * 뜹니다"처럼 시점을 약속하지 않는다.
 *
 * PO 지적(2026-08-02) — "다시 후보로 올라올 수 있습니다"는 상태 변화를 «약속»하는 문장이라
 * 이행처를 코드로 확認했다: `undo_rejection()`은 `rejected_relations` 행만 지운다
 * (backend/app/services/reference_semantic_candidates.py:609-629) — candidate 행이
 * «즉시» 돌아오지 않는다. 후보는 `build_candidate_rows()`(:125-167)가 story 저장
 * (create/update, stories.py의 `_reconcile_story_references_and_candidates`)마다
 * `_rejected_target_ids()`(:170-183)로 아직 기각된 쌍만 걸러 다시 만든다 — 되살린
 * 직후엔 그 필터에서 빠지므로 «다음 저장»이 있으면 같은 산문이 다시 후보가 된다. 그래서
 * 문구를 "다음 스토리 저장에서"로 조건까지 밝힌다 — "다시 후보로 올라올 수 있습니다"만
 * 쓰면 되살리기 직후 즉시 뜨는 것처럼 읽혀 "됐다는데 아무 일도 안 일어난다"가 된다.
 */
export function RejectedRelationsSection({ storyId }: { storyId: string }) {
  const t = useTranslations('board');
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetchWithAuth(`/api/stories/${storyId}/rejected-relations`, { cache: 'no-store' }).catch(() => null);
      if (cancelled) return;
      if (!res || !res.ok) { setState({ kind: 'failed' }); return; }
      const items = (await res.json().catch(() => null)) as RejectedRelationItem[] | null;
      if (cancelled) return;
      if (!items) { setState({ kind: 'failed' }); return; }
      // target_type은 지금 항상 "story"다(BE DELETE 라우트가 target_type="story"로 고정
      // 조회하는 것과 같은 사정) — 제목은 story 상세 엔드포인트로 조회한다.
      const titles = await Promise.all(items.map((it) =>
        fetchWithAuth(`/api/stories/${it.target_id}`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ));
      if (cancelled) return;
      setState({
        kind: 'ready',
        rows: items.map((item, i) => ({
          item, title: titles[i]?.data?.title ?? null, restoring: false, error: null, restored: false,
        })),
      });
    })();
    return () => { cancelled = true; };
  }, [storyId]);

  if (state.kind !== 'ready' || state.rows.length === 0) return null;

  const handleRestore = (targetId: string) => {
    setState((prev) => (prev.kind === 'ready'
      ? { ...prev, rows: prev.rows.map((r) => (r.item.target_id === targetId ? { ...r, restoring: true, error: null } : r)) }
      : prev));
    void fetch(`/api/stories/${storyId}/rejected-relations/${targetId}`, { method: 'DELETE' })
      .then(async (res) => {
        if (res.ok) {
          setState((prev) => (prev.kind === 'ready'
            ? { ...prev, rows: prev.rows.map((r) => (r.item.target_id === targetId ? { ...r, restoring: false, restored: true } : r)) }
            : prev));
          return;
        }
        // story #2485 — `json.detail`은 실 envelope({data,error,meta})에 없는 필드라 이
        // 분기는 항상 죽어있었다(그라운딩 확認). backend undo_story_rejected_relation()은
        // generic HTTP상태 코드(NOT_FOUND, 3가지 원인 구분불가)만 낸다 — 고정 폴백만 사용.
        const error = t('rejectedRelationsRestoreErrorFallback');
        setState((prev) => (prev.kind === 'ready'
          ? { ...prev, rows: prev.rows.map((r) => (r.item.target_id === targetId ? { ...r, restoring: false, error } : r)) }
          : prev));
      })
      .catch(() => {
        setState((prev) => (prev.kind === 'ready'
          ? { ...prev, rows: prev.rows.map((r) => (r.item.target_id === targetId ? { ...r, restoring: false, error: t('rejectedRelationsRestoreErrorFallback') } : r)) }
          : prev));
      });
  };

  return (
    <div className="border-t border-border/60 px-4 py-3">
      <p className="mb-2 text-xs font-medium text-muted-foreground">
        {t('rejectedRelationsTitle', { n: state.rows.length })}
      </p>
      <ul className="flex flex-col gap-1.5">
        {state.rows.map(({ item, title, restoring, error, restored }) => (
          <li key={item.id} className="flex flex-col gap-1 text-xs">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <span className="text-foreground [overflow-wrap:anywhere]">{title ?? t('rejectedRelationsTargetGone')}</span>
                <div className="text-[10px] text-muted-foreground">{formatRelativeTime(item.rejected_at)}</div>
              </div>
              {restored ? (
                // AC6 — 「다시 후보로 올라올 수 있습니다」까지만 말한다(시점 약속 없음).
                // 토스트가 아니라 이 행 자리에 그대로 남는다(㉣).
                <span className="shrink-0 text-[11px] text-muted-foreground">{t('rejectedRelationsRestored')}</span>
              ) : (
                <button
                  type="button"
                  disabled={restoring}
                  onClick={() => handleRestore(item.target_id)}
                  className="focus-outset shrink-0 rounded-md border border-border px-2 py-1 text-[11px] font-medium disabled:opacity-50"
                >
                  {t('rejectedRelationsRestore')}
                </button>
              )}
            </div>
            {error ? <p role="alert" className="text-[10px] text-destructive">{error}</p> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
