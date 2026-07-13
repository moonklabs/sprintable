'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ShieldCheck } from 'lucide-react';
import { ProofCapsule } from '@/components/proof-capsule/proof-capsule';
import {
  parseAttentionQueueSignals, buildAttentionQueueFromBe, buildAttentionQueue,
  type AttentionQueueItem, type AttentionQueueTranslator,
} from './derive-attention-queue';

const CAP = 7;

async function fetchAttentionQueue(projectId: string, t: AttentionQueueTranslator): Promise<AttentionQueueItem[]> {
  const json = await fetch(`/api/glance/attention?project_id=${projectId}`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  const signals = parseAttentionQueueSignals(json);
  return buildAttentionQueueFromBe(signals, t);
}

function RowSkeleton() {
  return <div className="h-[52px] animate-pulse border-b border-proof-line-soft bg-proof-sunk/60 last:border-b-0" />;
}

function AttentionRow({ item, onNavigate }: { item: AttentionQueueItem; onNavigate: (href: string) => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('a')) return;
        onNavigate(item.href);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onNavigate(item.href);
      }}
      className="cursor-pointer border-b border-proof-line-soft last:border-b-0 hover:bg-proof-sunk"
    >
      <ProofCapsule
        density="row"
        proofState={item.proofState}
        stateLabel={item.kindLabel}
        claim={item.claim}
        human={item.actor && !item.actor.isAgent ? { name: item.actor.name, role: '' } : undefined}
        agent={item.actor?.isAgent ? { name: item.actor.name, initial: item.actor.name.slice(0, 1) } : undefined}
        gate={{ action: item.actionLabel, href: item.href, tone: item.actionTone }}
        className="rounded-none border-0"
      />
    </div>
  );
}

/**
 * Attention Queue(E-UI-DAEGBYEON P0-05, story 7ff12083, 설계 5f25c615). "지금 개입할 3~7개"만 —
 * 원시 이벤트 나열 아니라 판단이 필요한 것만. Proof Capsule row density 재사용(신규 컴포넌트 아님).
 * 배치 = `/inbox?tab=attention`(지금/Now 존·기존 인박스 병행 — PO 확定 2026-07-13).
 *
 * 2단계(BE 계약 스왑) 완료: 데이터 소스 = `/glance/attention`(P0-04 trust 파이프라인 파생, doc
 * trust-pipeline-be-design §6). 4유형(검증실패/결정필요[needs_input+gate_pending 합류]/막힘/
 * 병합대기) — 범위이탈(Red)은 BE가 §7 확定②로 여전히 미구현이라 항상 빈 신호(no-fiction 렌더
 * 생략). actor(human/agent 아바타)는 BE `AttentionItem`에 assignee 필드가 없어 당분간 없음
 * (P0-03 `human_owner_member_id` 노출 시 복원 예정 — 별도 low 스토리). SSE 실시간 반영(P0-04
 * "새로고침 없이" 완료기준의 잔여)은 BE 브릿지 미비로 이 스토리 스코프 밖(별도 high 스토리).
 */
export function AttentionQueueView({ projectId }: { projectId: string }) {
  const router = useRouter();
  const t = useTranslations('attentionQueue');
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<AttentionQueueItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      const result = await fetchAttentionQueue(projectId, t);
      if (cancelled) return;
      setItems(result);
      setLoading(false);
    }
    void load();
    return () => { cancelled = true; };
  }, [projectId, t]);

  const { shown, overflow } = buildAttentionQueue(items, CAP);

  return (
    <div className="overflow-hidden rounded-2xl border border-proof-line bg-proof-panel" style={{ clipPath: 'polygon(0 0, calc(100% - 24px) 0, 100% 24px, 100% 100%, 0 100%)' }}>
      <div className="flex items-baseline justify-between gap-3 border-b border-proof-line-soft px-5 py-3.5">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-proof-faint">{t('kicker')}</div>
          <h2 className="text-[19px] font-extrabold leading-tight tracking-[-0.014em] text-proof-ink">{t('title')}</h2>
        </div>
        {!loading ? (
          <div className="shrink-0 text-[13px] font-medium text-proof-ink-3">
            {t.rich('count', { count: shown.length, b: (chunks) => <b className="text-proof-ink">{chunks}</b> })}
          </div>
        ) : null}
      </div>

      {loading ? (
        <div>{Array.from({ length: 3 }).map((_, i) => <RowSkeleton key={i} />)}</div>
      ) : shown.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-5 py-10 text-center">
          <div className="inline-flex items-center gap-1.5 text-[11px] font-bold tracking-[0.02em] text-proof-green">
            <ShieldCheck className="size-3.5" aria-hidden="true" />{t('allClear')}
          </div>
          <p className="text-[15px] font-semibold text-proof-ink-2">{t('emptyTitle')}</p>
          <p className="text-[12.5px] text-proof-faint">{t('emptyBody')}</p>
        </div>
      ) : (
        <div>
          {shown.map((item) => (
            <AttentionRow key={item.id} item={item} onNavigate={(href) => router.push(href)} />
          ))}
          {overflow > 0 ? (
            <div className="flex items-center gap-1.5 border-t border-proof-line-soft bg-proof-sunk px-5 py-2.5 text-[12.5px] text-proof-ink-3">
              <span className="size-1 rounded-full bg-proof-faint" aria-hidden="true" />
              {t('flowDemoted', { overflow })}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
