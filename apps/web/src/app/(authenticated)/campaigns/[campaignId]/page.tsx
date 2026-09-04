'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { fetchWithAuth } from '@/lib/db/client';
import { channelLabel } from '@/lib/channel-label';
import { deriveChannelPostView, type ChannelPublicationStatus } from '@/components/content/channel-post-status';
import { StatusChip } from '@/components/content/status-chip';
import type { ContentPostStatusInput } from '@/components/content/post-status';

// story 1db41045(#3457) — campaign 상세. backend/app/routers/campaigns.py::
// get_campaign_detail_endpoint 응답 그대로(조인 축을 이 화면이 새로 안 짠다). 조직
// 멤버면 휴먼·에이전트 모두 읽기 가능(생성만 human-only) — 이 화면 자체는 휴먼 전용
// 표면(원문 상세와 같은 관례, 에이전트는 API로 같은 조회를 직접 한다).
interface CampaignVariantItem {
  draft_id: string;
  channel: string;
  gate_status?: string | null;
  reapproval_required?: boolean | null;
  sealed_content_sha256?: string | null;
  body_sha256: string;
  publication_status?: string | null;
  error_code?: string;
  published_at?: string | null;
}

interface CampaignContentItem {
  content_item_id: string;
  slug: string;
  lang: string;
  title: string;
  current_version: number;
  updated_at: string;
  variants: CampaignVariantItem[];
}

interface CampaignDetail {
  id: string;
  name: string;
  starts_at: string | null;
  ends_at: string | null;
  status: string;
  created_by_member_id: string;
  created_at: string;
  content_items: CampaignContentItem[];
}

function toGateStatus(status: string | undefined): ContentPostStatusInput['gateStatus'] {
  return status === 'pending' || status === 'approved' || status === 'rejected' ? status : undefined;
}

function realStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

// 유나 정적 판정(2026-09-04 17:50Z) — status 원문 영문값("active")을 그대로 노출했다.
// backend/app/models/campaign.py::status는 제약 없는 Text(server_default="active") —
// 지금은 값이 하나뿐이지만 라벨 키를 미리 두고, 모르는 값은 지어내지 않고 원문 그대로
// 보인다(§17 값+라벨 관례).
const CAMPAIGN_STATUS_LABEL_KEYS: Record<string, string> = {
  active: 'campaignStatusActive',
};

export default function CampaignDetailPage() {
  const { campaignId } = useParams<{ campaignId: string }>();
  const { orgId } = useDashboardContext();
  const t = useTranslations('content');

  const [campaign, setCampaign] = useState<CampaignDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  // 유나 정적 판정(2026-09-04 17:50Z) — notFound||!campaign 하나로 500·네트워크
  // 실패까지 "찾을 수 없습니다"로 뭉뚱그렸다. editLoadFailed 선례처럼 "존재 안 함"
  // (404)과 "조회 실패"(그 외)를 가른다 — 지어낸 판정 없이 서버가 준 상태 그대로.
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      setNotFound(false);
      setLoadError(false);
      try {
        const res = await fetchWithAuth(`/api/organizations/${orgId}/campaigns/${campaignId}`);
        if (cancelled) return;
        if (res.status === 404) {
          setNotFound(true);
          return;
        }
        if (res.ok) {
          const json = (await res.json().catch(() => null)) as { data?: CampaignDetail } | null;
          if (json?.data) {
            setCampaign(json.data);
          } else {
            setLoadError(true);
          }
        } else {
          setLoadError(true);
        }
      } catch {
        if (!cancelled) setLoadError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [orgId, campaignId]);

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-4 p-6">
        <div className="h-8 w-1/2 animate-pulse rounded-md bg-muted" />
        <div className="h-64 animate-pulse rounded-md bg-muted" />
      </div>
    );
  }
  if (notFound) {
    return (
      <div className="mx-auto w-full max-w-3xl p-6">
        <Alert variant="destructive" role="alert" aria-live="assertive" aria-atomic="true">
          <AlertDescription>{t('campaignNotFound')}</AlertDescription>
        </Alert>
      </div>
    );
  }
  if (loadError || !campaign) {
    return (
      <div className="mx-auto w-full max-w-3xl p-6">
        <Alert variant="destructive" role="alert" aria-live="assertive" aria-atomic="true">
          <AlertDescription>{t('campaignLoadFailed')}</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold text-foreground" data-testid="campaign-detail-name">{campaign.name}</h1>
          <Badge variant="outline">
            {CAMPAIGN_STATUS_LABEL_KEYS[campaign.status] ? t(CAMPAIGN_STATUS_LABEL_KEYS[campaign.status]) : campaign.status}
          </Badge>
        </div>
      </div>

      {campaign.content_items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('campaignNoContentItems')}</p>
      ) : (
        <ul className="space-y-3">
          {campaign.content_items.map((item) => (
            <li key={item.content_item_id} className="space-y-1.5 rounded-md border border-border p-3 text-sm" data-testid="campaign-detail-content-item">
              <Link href={`/content/${item.content_item_id}`} className="font-medium underline">
                {item.title}
              </Link>
              {item.variants.length > 0 ? (
                <ul className="space-y-1 pl-3">
                  {item.variants.map((v) => (
                    <li key={v.draft_id} className="flex items-center justify-between gap-2" data-testid="campaign-detail-variant-item">
                      <Link href={`/content/channel-posts/${v.draft_id}`} className="underline">
                        {channelLabel(v.channel, t)}
                      </Link>
                      <StatusChip
                        status={deriveChannelPostView({
                          gateStatus: toGateStatus(v.gate_status ?? undefined),
                          reapprovalRequired: v.reapproval_required ?? undefined,
                          sealedBodySha256: realStr(v.sealed_content_sha256),
                          currentBodySha256: v.body_sha256,
                          publicationStatus: v.publication_status as ChannelPublicationStatus | null | undefined,
                          errorCode: v.error_code,
                          publishedAt: v.published_at,
                        }).status}
                      />
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
