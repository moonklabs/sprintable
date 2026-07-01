'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ArrowLeft, FileText, GitBranch, ShieldAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { LoopStatusBadge, type LoopStatus } from '@/components/loops/loop-status-badge';
import { VariantGallery, type VariantGroup } from '@/components/loops/variant-gallery';

interface Loop {
  id: string;
  project_id: string;
  parent_loop_id: string | null;
  hypothesis_id: string | null;
  brief_doc_id: string | null;
  recipe_slug: string | null;
  title: string;
  goal_tags: string[];
  status: LoopStatus;
}

interface Hypothesis {
  id: string;
  statement: string;
}

interface DocSummary {
  id: string;
  title: string;
  slug: string;
}

/**
 * loopId별 리마운트는 부모 page.tsx의 key={loopId}가 강제한다 — Next App Router가
 * 같은 [id] 템플릿 인스턴스를 소프트-nav 시 재사용해 이전 loop의 notFound/loop/hypothesis/
 * brief state가 잔존하는 버그 클래스(A3 AuditClient·S8 TenantsClient에 이은 3번째 재발
 * ·까심 QA 적출) — route param으로 fetch하는 상세 page는 항상 key-remount.
 */
export function LoopDetailClient({ loopId }: { loopId: string }) {
  const t = useTranslations('loops');
  const router = useRouter();

  const [loop, setLoop] = useState<Loop | null>(null);
  const [hypothesis, setHypothesis] = useState<Hypothesis | null>(null);
  const [brief, setBrief] = useState<DocSummary | null>(null);
  const [groups, setGroups] = useState<VariantGroup[]>([]);
  const [isHuman, setIsHuman] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const fetchAll = useCallback(async () => {
    try {
      const loopRes = await fetch(`/api/loops/${loopId}`);
      if (!loopRes.ok) { setNotFound(true); return; }
      const loopData = (await loopRes.json()) as Loop;
      setLoop(loopData);
      setNotFound(false);

      const [artifactsRes, meRes] = await Promise.all([
        fetch(`/api/loops/${loopId}/artifacts`),
        fetch('/api/me'),
      ]);
      if (artifactsRes.ok) setGroups((await artifactsRes.json()) as VariantGroup[]);
      if (meRes.ok) {
        const { data } = (await meRes.json()) as { data: { type: string } };
        setIsHuman(data.type === 'human');
      }

      if (loopData.hypothesis_id) {
        const hRes = await fetch(`/api/hypotheses/${loopData.hypothesis_id}`);
        if (hRes.ok) {
          const { data } = (await hRes.json()) as { data: Hypothesis };
          setHypothesis(data);
        }
      } else {
        setHypothesis(null);
      }

      if (loopData.brief_doc_id) {
        const dRes = await fetch(`/api/docs/${loopData.brief_doc_id}/summary`);
        if (dRes.ok) {
          const { data } = (await dRes.json()) as { data: DocSummary };
          setBrief(data);
        }
      } else {
        setBrief(null);
      }
    } catch (err) {
      console.error('[loops] 상세를 불러오지 못했습니다', err);
    } finally {
      setLoading(false);
    }
  }, [loopId]);

  useEffect(() => { void fetchAll(); }, [fetchAll]);

  if (loading) {
    return (
      <>
        <TopBarSlot title={<h1 className="text-sm font-medium">{t('title')}</h1>} />
        <div className="flex h-64 items-center justify-center">
          <p className="text-sm text-muted-foreground">{t('loading')}</p>
        </div>
      </>
    );
  }

  if (notFound || !loop) {
    return (
      <>
        <TopBarSlot title={<h1 className="text-sm font-medium">{t('title')}</h1>} />
        <div className="flex h-64 flex-col items-center justify-center gap-3">
          <p className="text-sm text-muted-foreground">{t('notFound')}</p>
          <button type="button" onClick={() => router.push('/loops')} className="text-xs text-primary hover:underline">
            {t('backToList')}
          </button>
        </div>
      </>
    );
  }

  const canDecide = isHuman && loop.status === 'deciding';
  const totalSlots = groups.length;
  const decidedSlots = groups.filter((g) => g.artifacts.every((a) => a.decision !== 'pending')).length;

  return (
    <>
      <TopBarSlot
        title={
          <button
            type="button"
            onClick={() => router.push('/loops')}
            className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" />
            {t('backToList')}
          </button>
        }
      />
      <div className="mx-auto max-w-3xl space-y-5 overflow-y-auto p-5">
        {/* Header */}
        <div className="space-y-2.5">
          <div className="flex items-start justify-between gap-2">
            <h1 className="text-lg font-bold text-foreground">{loop.title}</h1>
            <LoopStatusBadge status={loop.status} />
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {loop.parent_loop_id ? (
              <span className="inline-flex items-center gap-1">
                <GitBranch className="size-3" aria-hidden />
                {t('lineageFrom', { id: loop.parent_loop_id.slice(0, 8) })}
              </span>
            ) : null}
            {loop.recipe_slug ? (
              <span>{t('recipeLabel')}: <span className="font-mono">{loop.recipe_slug}</span></span>
            ) : null}
            {totalSlots > 0 ? <span>{t('decisionProgress', { done: decidedSlots, total: totalSlots })}</span> : null}
          </div>

          {loop.goal_tags.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {loop.goal_tags.map((tag) => (
                <Badge key={tag} variant="chip" className="text-[10px]">{tag}</Badge>
              ))}
            </div>
          ) : null}

          {/* Goal / hypothesis */}
          <div className="rounded-lg border border-border bg-muted/40 p-3">
            <p className="mb-1 text-xs font-medium text-muted-foreground">{t('goalLabel')}</p>
            <p className="text-sm text-foreground">
              {hypothesis?.statement ?? <span className="italic text-muted-foreground">{t('goalEmpty')}</span>}
            </p>
            {brief ? (
              <Link
                href={`/docs/${brief.slug}`}
                className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                <FileText className="size-3" aria-hidden />
                {t('briefLink')}: {brief.title}
              </Link>
            ) : null}
          </div>

          {/* Moat framing — decision UX = 이 화면의 심장(handoff §2) */}
          {totalSlots > 0 && loop.status === 'deciding' ? (
            <div className="rounded-lg border border-info-border bg-info-tint p-2.5 text-xs text-info">
              🧠 <span className="font-semibold">{t('moatFraming')}</span> — {t('moatFramingDesc')}
            </div>
          ) : null}

          {/* View-only / human-only notices */}
          {totalSlots > 0 && loop.status !== 'deciding' ? (
            <p className="text-xs text-muted-foreground">{t('notDecidingNotice')}</p>
          ) : null}
          {totalSlots > 0 && loop.status === 'deciding' && !isHuman ? (
            <div className="flex items-center gap-1.5 rounded-lg border border-warning-border bg-warning-tint px-2.5 py-2 text-xs text-warning">
              <ShieldAlert className="size-3.5 shrink-0" aria-hidden />
              {t('humanOnlyNotice')}
            </div>
          ) : null}
        </div>

        {/* Variant gallery */}
        <VariantGallery loopId={loop.id} groups={groups} canDecide={canDecide} onDecided={() => void fetchAll()} />
      </div>
    </>
  );
}
