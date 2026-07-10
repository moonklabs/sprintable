'use client';

import { useCallback, useState } from 'react';
import {
  ChevronDown, ChevronUp, ExternalLink, Link2, Paperclip,
  GitPullRequest, Rocket, TrendingUp, FileText, CheckCircle2,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { TrustSeal } from './trust-seal';
import type { EvidenceItem, EvidenceType } from '@/services/verify';

const VISIBLE_LIMIT = 4;

const TYPE_ICON: Record<EvidenceType, typeof Link2> = {
  url: Link2,
  file: Paperclip,
  pr: GitPullRequest,
  deploy: Rocket,
  metric: TrendingUp,
  report: FileText,
  gate_approval: CheckCircle2,
};

const TYPE_LABEL_KEY: Record<EvidenceType, string> = {
  url: 'evidenceTypeUrl',
  file: 'evidenceTypeFile',
  pr: 'evidenceTypePr',
  deploy: 'evidenceTypeDeploy',
  metric: 'evidenceTypeMetric',
  report: 'evidenceTypeReport',
  gate_approval: 'evidenceTypeGateApproval',
};

/** ref가 실제로 새 탭을 열 수 있는 URL인지 — 아닌 타입(예: metric 수치 설명)은 링크로 렌더하지 않는다. */
export function isLinkableRef(ref: string): boolean {
  return /^https?:\/\//i.test(ref);
}

interface EvidenceSectionProps {
  workItemId: string;
  workItemType: 'story' | 'task';
  /** BE list/get 응답의 has_evidence 신호. false는 절대 오지 않음(null=무증거) — undefined도 무증거로 취급. */
  hasEvidence: boolean | null | undefined;
  memberMap?: Record<string, { name: string }>;
  className?: string;
}

/**
 * E-VERIFY V0-S3 Lv1(접힘 신뢰 행) + Lv2(펼침 evidence 카드). 유나 S4 핸드오프 §3/§4 준수.
 * "근거 보기" 클릭 시에만 evidence 리스트를 호출한다(디디 BE 가이드 — 리스트 렌더 시 카드마다
 * 부르지 않는 게 정합, has_evidence 하나로 Lv0 씰 표시는 충분). 그래서 fetch 전엔 건수를 모른다 —
 * Lv1 라벨은 펼치기 전엔 카운트 없이 "증명된 완결"만, 펼친 후 실 카운트로 채워진다.
 */
export function EvidenceSection({ workItemId, workItemType, hasEvidence, memberMap = {}, className }: EvidenceSectionProps) {
  const t = useTranslations('verify');
  const tCommon = useTranslations('common');
  const [expanded, setExpanded] = useState(false);
  const [items, setItems] = useState<EvidenceItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const fetchEvidence = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch(`/api/evidence?work_item_id=${workItemId}&work_item_type=${workItemType}`);
      if (!res.ok) { setError(true); return; }
      const json = (await res.json()) as { data?: EvidenceItem[] };
      setItems(json.data ?? []);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [workItemId, workItemType]);

  const handleToggle = () => {
    if (!expanded && items === null) { void fetchEvidence(); }
    setExpanded((v) => !v);
  };

  // 증거 0 = 신뢰 행 자체를 렌더하지 않는다(§7 상태 매트릭스 — 현행과 동일 무표시, "증명 안 됨" 금지).
  if (!hasEvidence) return null;

  const visibleItems = items && !showAll ? items.slice(0, VISIBLE_LIMIT) : items;
  const hiddenCount = items ? items.length - VISIBLE_LIMIT : 0;
  const signerId = items?.[0]?.created_by ?? null;
  const signerName = signerId ? memberMap[signerId]?.name : null;

  return (
    <div className={className}>
      <div className="rounded-lg border border-border p-2.5">
        <button type="button" onClick={handleToggle} className="flex w-full items-center gap-2 text-left">
          <TrustSeal />
          <span className="text-xs font-semibold text-foreground">{t('provenCompletion')}</span>
          {items ? (
            <span className="text-[11px] text-muted-foreground">· {t('evidenceCount', { count: items.length })}</span>
          ) : null}
          <span className="ml-auto flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
            {expanded ? t('evidenceHide') : t('evidenceShow')}
            {expanded ? <ChevronUp className="h-3 w-3" aria-hidden /> : <ChevronDown className="h-3 w-3" aria-hidden />}
          </span>
        </button>

        {expanded ? (
          <div className="mt-2 border-t border-border pt-2">
            {loading ? (
              <p className="text-[11px] text-muted-foreground">{tCommon('loading')}</p>
            ) : error ? (
              <p className="text-[11px] text-destructive">{t('evidenceLoadError')}</p>
            ) : items && items.length > 0 ? (
              <>
                {signerName ? (
                  <p className="mb-1.5 text-[11px] text-muted-foreground">{t('evidenceSignedBy', { name: signerName })}</p>
                ) : null}
                <ul className="space-y-1">
                  {(visibleItems ?? []).map((item) => {
                    const Icon = TYPE_ICON[item.type] ?? Link2;
                    const linkable = isLinkableRef(item.ref);
                    const primaryText = item.note || item.ref;
                    return (
                      <li key={item.id} className="flex items-start gap-2 rounded-md px-1.5 py-1 hover:bg-muted/40">
                        <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                        <div className="min-w-0 flex-1">
                          {linkable ? (
                            <a
                              href={item.ref}
                              target="_blank"
                              rel="noreferrer"
                              className="flex items-center gap-1 text-xs font-medium text-foreground hover:underline"
                            >
                              <span className="truncate">{primaryText}</span>
                              <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground/70" aria-hidden />
                            </a>
                          ) : (
                            <span className="block truncate text-xs font-medium text-foreground">{primaryText}</span>
                          )}
                          {item.source ? <p className="truncate text-[11px] text-muted-foreground/80">{item.source}</p> : null}
                        </div>
                        <span className="mt-0.5 shrink-0 text-[10px] font-semibold text-muted-foreground">
                          {t(TYPE_LABEL_KEY[item.type] ?? 'evidenceTypeUrl')}
                        </span>
                      </li>
                    );
                  })}
                </ul>
                {hiddenCount > 0 && !showAll ? (
                  <button
                    type="button"
                    onClick={() => setShowAll(true)}
                    className="mt-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                  >
                    {t('evidenceMore', { count: hiddenCount })}
                  </button>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
