'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { fetchWithAuth } from '@/lib/db/client';
import {
  deriveContentPostStatus,
  type ContentPostStatusInput,
} from '@/components/content/post-status';
import { deriveChannelPostView, type ChannelPublicationStatus } from '@/components/content/channel-post-status';
import { StatusChip } from '@/components/content/status-chip';
import { AuthorKindBadge } from '@/components/content/author-kind-badge';
import { parseSitePostApiError } from '@/components/content/api-error';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { formatScheduledAt, resolveDisplayTimezone } from '@/components/content/schedule-format';
import { RawDetailsToggle } from '@/components/content/raw-details-toggle';

/**
 * story #3368(Phase0·마케팅운영 S4, doc phase0-post-manager-screen-design §8-1 순서 3번) —
 * 글 편집(와이어프레임 S3·S4). slug·lang은 첫 버전 뒤 잠근다(페드루 정정 2026-09-03: 서버가
 * (org, work_item_id, slug)로 기존 초안을 매칭하므로 slug를 바꾸면 새 초안이 생겨 이력이
 * 갈라진다) — 편집 가능한 필드는 title·summary·tags·body_md뿐이다.
 *
 * ⚠️원안/수정본 대조 패널(와이어프레임 S4)은 이 슬라이스에 없다 — §8-1 명시: "4·6이 봉인
 * 해시(BE §4-3 3번)에 걸려 있다 ... 4·6은 BE 봉인이 착지한 뒤에 시작한다." 오늘은 최신
 * 버전 단일 폼만 그린다.
 *
 * 승인 요청(와이어프레임 S5) — 페드루 PO 판정(2026-09-03): FE가 generic `POST /gates`에
 * role_id를 지어 넣지 않는다(계약 갭, gates.py::GateCreateRequest가 role_id 필수인데
 * eligible-approvers 응답엔 없음). 대신 디디군 S2 전용 엔드포인트 계약으로 stub 배선한다
 * (`POST .../drafts/{draft_id}/submit`, role_id 해소·게이트 pending 생성·봉인은 전부
 * 서버 책임) — S2 착지 전까지는 404가 그대로 뜬다(정상, 계약 stub). 성공하면 gate_id로
 * `/gates/{id}` 딥링크(§6-1 재사용 목록, 게이트 상세)한다.
 */

interface SitePostVersion {
  version_id: string;
  version: number;
  slug: string;
  source_story_id: string;
  title: string;
  lang: string;
  summary: string;
  tags: string[];
  body_md: string;
  body_sha256: string;
  author_member_id: string;
  author_kind: 'agent' | 'human';
  created_at: string;
  // story 1db41045(#3457) — 이 원문이 속한 campaign. 없으면 null(정상값, 단독 글).
  // 페드루 PO 確定(2026-09-04 17:03Z) — 디디 BE 소형 후속이 이 두 필드를
  // SitePostVersionHistoryItem에 얹은 뒤에야(source_content_item_id 옆) 이 계약이
  // 실물과 맞다 — 필드명 대조 없이는 조용히 버려지는 자리라 rebase 뒤 재확認 필수.
  campaign_id?: string | null;
  campaign_name?: string | null;
}

// story 1db41045(#3457) — GET /organizations/{org}/campaigns 응답 1건(디디 BE 소형
// 후속, CampaignResponse 재사용·GET/{id}와 같은 권한 폭·created_at desc — 페드루 PO
// 確定 2026-09-04 17:01Z).
interface CampaignListItem {
  id: string;
  name: string;
  starts_at: string | null;
  ends_at: string | null;
  status: string;
  created_by_member_id: string;
  created_at: string;
}

// story #3368 §8-1 4단(페드루 지시 2026-09-03) — 이 work item의 external_publish
// 게이트. GET /api/gates?work_item_id=&work_item_type=는 기존 범용 라우트(doc-gate-
// section.tsx와 동형 재사용, 새 엔드포인트 0). 봉인 필드는 neutral_facts가 아니라 Gate
// 전용 컬럼 4종이다(S2, PR#3733 — GateResponse가 Gate ORM 컬럼명 그대로 top-level에
// 얹는다, gates.py::GateResponse).
interface GateInfo {
  id: string;
  status: string;
  sealed_content_version?: number | null;
  sealed_content_sha256?: string | null;
  sealed_content_body?: string | null;
  reapproval_required?: boolean;
}

// story #3386(Phase0 결함, S8 — 발행됨·URL·행위자) — GET .../drafts/{draftId}/publication.
// 발행된 적 없으면(또는 unpublish됐으면) 서버가 전부 null을 준다(200 — 404는 draft 자체가
// 없을 때만, "모른다"와 "발행 안 됐다"를 구별하는 서버측 신호).
interface SitePostPublicationInfo {
  published_at: string | null;
  url: string | null;
  published_by_member_id: string | null;
  published_body_sha256: string | null;
}

function realStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

// story 15e481ce(#3453 AC1) — 활성 소셜 연결(어댑터가 사회형이라는 것은 애초에 connection
// row가 존재한다는 사실 자체로 이미 참이다 — hosted_site는 requires_connection=false라
// connection row가 없다, backend/app/services/channel_adapters.py 그라운딩). 그래서
// channel-connections 목록을 kind로 다시 거를 필요가 없다 — status=active만 본다.
interface ActiveConnectionOption {
  id: string;
  channel: string;
  account_label: string | null;
  status: string;
}

// story 15e481ce(#3453 AC2, 유나 §14-2) — 원문 상세의 "같은 스토리의 채널 글" 역방향
// 목록. §14-2가 요구하는 값만(채널·상태 칩·상세 링크) — 그 이상은 목록 응답에 없다.
interface ChannelPostVariantItem {
  draft_id: string;
  channel: string;
  connection_id: string;
  gate_status?: string | null;
  reapproval_required?: boolean | null;
  sealed_content_sha256?: string | null;
  body_sha256: string;
  publication_status?: string | null;
  error_code?: string;
  published_at?: string | null;
}

// Gate.status는 auto_passed/voided/held 등도 가질 수 있지만 Phase 0 external_publish는
// 휴먼 승인만 인정(auto_passed 도달 불가, doc phase0-post-manager-screen-design §3-1
// 각주) — pending/approved/rejected 셋 밖은 "유효한 승인 대상 없음"과 동형으로 undefined
// 처리해 deriveContentPostStatus가 'draft'로 안전하게 떨어지게 한다.
function toGateStatus(status: string | undefined): ContentPostStatusInput['gateStatus'] {
  return status === 'pending' || status === 'approved' || status === 'rejected' ? status : undefined;
}

export default function ContentPostEditPage() {
  const { draftId } = useParams<{ draftId: string }>();
  const { orgId, role } = useDashboardContext();
  const t = useTranslations('content');

  const [versions, setVersions] = useState<SitePostVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [tagsText, setTagsText] = useState('');
  const [bodyMd, setBodyMd] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<
    { type: 'success'; text: string } | { type: 'error'; text: string; raw?: string } | null
  >(null);

  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<
    | { type: 'success'; gateId: string }
    // story f6d14476(AC3) — SITE_POST_GATE_ALREADY_HELD는 원인 문구만이 아니라 그 게이트를
    // 쥔 상대 초안 링크까지 보여야 한다 — heldByDraftId가 있을 때만 렌더한다.
    | { type: 'error'; text: string; raw?: string; heldByDraftId?: string }
    | null
  >(null);

  const [gate, setGate] = useState<GateInfo | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishResult, setPublishResult] = useState<
    // S3(story #3369) 계약 — url은 항상 온다(발행 URL을 서버가 조립·보증, 화면이 지어내지
    // 않는다). string | null이던 것은 레거시 endpoint(url 필드 자체가 없던 시절)의 흔적.
    | { type: 'success'; url: string; publishedAt: string }
    // reapprovalHashes — §8-3④-1(페드루 PO): 409 SITE_POST_REAPPROVAL_REQUIRED는 S10의
    // 일반 오류가 아니라 S9와 같은 처리(문구+해시 병치)여야 한다. 서버가 해시 값 자체를
    // 돌려주지 않아도(계약 미확정) 클라이언트가 이미 양쪽 해시를 갖고 있으니(gate 봉인
    // 해시·latest 현재 해시) 그걸로 병치한다 — 서버 응답을 지어내지 않는다.
    | { type: 'error'; text: string; raw?: string; reapprovalHashes?: { sealed?: string; current: string } }
    | null
  >(null);

  // story #3386 — S8(발행됨·URL·행위자). undefined=아직 안 물어봤다(첫 렌더), null=물어봤는데
  // 실패(best-effort — gate 조회와 동형, 화면 전체를 막지 않는다), 객체=성공(발행 안 됐어도
  // 전부 null 필드로 옴 — 그 자체가 "안다"는 신호라 undefined와는 다르다, AC6).
  const [publication, setPublication] = useState<SitePostPublicationInfo | null | undefined>(undefined);
  // 페드루 PO 리뷰(2026-09-03, 유나 design verdict) — 발행자가 UUID 그대로 보이는 문제.
  // gates/[id]/page.tsx의 memberNames 관례(id→이름, /api/team-members, 못 찾으면 앞 8자
  // 폴백) 그대로 재사용한다 — publication 계약을 늘리지 않는다(이름 필드를 새로 추가하지
  // 않는다).
  const [memberNames, setMemberNames] = useState<Record<string, string>>({});
  const [unpublishing, setUnpublishing] = useState(false);
  const [unpublishConfirmOpen, setUnpublishConfirmOpen] = useState(false);
  const [unpublishResult, setUnpublishResult] = useState<
    { type: 'success' } | { type: 'error'; text: string; raw?: string } | null
  >(null);

  // story 15e481ce(#3453 AC1) — 「Threads 변형 만들기」. 활성 연결 목록·이미 만든 변형
  // 목록은 서로 다른 조회(연결=channel-connections, 변형=variants) — 같이 로드한다.
  const [activeConnections, setActiveConnections] = useState<ActiveConnectionOption[]>([]);
  const [variants, setVariants] = useState<ChannelPostVariantItem[]>([]);
  const [selectedConnectionId, setSelectedConnectionId] = useState('');
  const [creatingVariant, setCreatingVariant] = useState(false);
  // 유나 사전 스티어(2026-09-04, PR#3799 head)④, #3801 착지분 — raw 캡처+토글
  // (RawDetailsToggle 공용화) 둘 다 이제 여기 있다.
  const [createVariantResult, setCreateVariantResult] = useState<{ type: 'error'; text: string; raw?: string } | null>(null);
  const router = useRouter();
  // 유나 사전 스티어② — 변형 행의 published_at 표시. 조직 tz 폴백 관례는 channel-posts
  // 상세 화면과 동형(resolveDisplayTimezone()의 기본 인자 규약 그대로 재사용).
  const displayTimezone = resolveDisplayTimezone().tz;

  // story 1db41045(#3457) — 「캠페인 만들기/붙이기」. 목록(기존 선택)·새 이름(만들기)
  // 둘 다 이 자리에서 다룬다. 둘 다 지정하면 "새로 만들기"가 우선(사람이 방금 타이핑한
  // 것이 최신 의도 — select를 초기화 안 해도 자연스럽게 이긴다).
  const [campaigns, setCampaigns] = useState<CampaignListItem[]>([]);
  const [selectedCampaignId, setSelectedCampaignId] = useState('');
  const [newCampaignName, setNewCampaignName] = useState('');
  const [attachingCampaign, setAttachingCampaign] = useState(false);
  const [attachCampaignResult, setAttachCampaignResult] = useState<{ type: 'error'; text: string; raw?: string } | null>(null);
  // 페드루 PO B2(2026-09-04 17:39Z) — 붙인 뒤에도 「변경」/「해제」 표면이 있어야
  // AC2("campaign_id 편집")가 첫 1회로 안 끝난다. changingCampaign=true면
  // campaign_id가 있어도 붙이기 폼을 다시 연다(같은 폼 재사용, 새 컴포넌트 0).
  const [changingCampaign, setChangingCampaign] = useState(false);
  const [detachingCampaign, setDetachingCampaign] = useState(false);
  const [detachCampaignResult, setDetachCampaignResult] = useState<{ type: 'error'; text: string; raw?: string } | null>(null);

  const loadCampaigns = useCallback(async () => {
    if (!orgId) return;
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgId}/campaigns`);
      if (!res.ok) return;
      const json = (await res.json().catch(() => null)) as { data?: CampaignListItem[] } | null;
      setCampaigns(json?.data ?? []);
    } catch {
      // 목록은 부가 정보(선택지 채우기) — 조회 실패로 "새로 만들기"까지 막지 않는다.
    }
  }, [orgId]);

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      setLoadError(false);
      try {
        const res = await fetchWithAuth(`/api/organizations/${orgId}/site-posts/drafts/${draftId}/versions`);
        if (cancelled) return;
        if (res.ok) {
          const json = (await res.json().catch(() => null)) as { data?: SitePostVersion[] } | null;
          const list = json?.data ?? [];
          setVersions(list);
          const latest = list[list.length - 1];
          if (latest) {
            setTitle(latest.title);
            setSummary(latest.summary);
            setTagsText(latest.tags.join(', '));
            setBodyMd(latest.body_md);
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
    return () => {
      cancelled = true;
    };
  }, [orgId, draftId]);

  const latest = versions[versions.length - 1];
  const workItemId = latest?.source_story_id;

  // story 15e481ce(#3453 AC1·AC2) — 활성 연결 목록(변형 만들기 선택지)과 이미 만든
  // 변형 목록(§14-2 "같은 스토리의 채널 글")을 같이 부른다. onRefresh 없이 draftId
  // 로드 시 한 번(변형 생성 성공 뒤엔 loadVariants만 다시 부른다 — 아래 handleCreateVariant).
  const loadVariants = useCallback(async () => {
    if (!orgId) return;
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgId}/site-posts/drafts/${draftId}/variants`);
      if (!res.ok) return;
      const json = (await res.json().catch(() => null)) as { data?: ChannelPostVariantItem[] } | null;
      setVariants(json?.data ?? []);
    } catch {
      // §14-2 표기는 있으면 보이고 없으면 안 보이는 부가 정보 — 조회 실패로 화면
      // 전체를 막지 않는다(gate·publication best-effort 조회와 동형 관례).
    }
  }, [orgId, draftId]);

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    void loadVariants();
    void loadCampaigns();
    fetchWithAuth(`/api/organizations/${orgId}/channel-connections`)
      .then(async (r) => {
        if (cancelled || !r.ok) return;
        const json = (await r.json().catch(() => null)) as { data?: ActiveConnectionOption[] } | null;
        setActiveConnections((json?.data ?? []).filter((c) => c.status === 'active'));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [orgId, loadVariants, loadCampaigns]);

  // story 15e481ce(#3453 AC1) — 「Threads 변형 만들기」. text는 min_length=1(BE 검증) —
  // 빈 문자열을 보낼 수 없어 summary를 채워 넣고, summary도 비어 있으면 title로
  // 폴백한다. link_url은 발행된 URL이 있으면 그 값(없으면 null — 지어내지 않는다).
  //
  // 카디르 QA 지적(2026-09-04, PR#3799) — title도 trim 없이 그대로 썼다. summary·
  // title 둘 다 공백뿐이면 trim 전엔 공백 문자열이 BE min_length=1을 그대로 통과해
  // 버린다(공백 1글자도 "길이 1"). 그래서 title도 trim하고, 결과가 그래도 비면
  // 아예 POST를 안 보낸다(버튼도 비활성 — variantTextEmpty, 아래 렌더 참고).
  const variantText = (latest?.summary.trim() || latest?.title.trim()) ?? '';
  const variantTextEmpty = latest !== undefined && variantText === '';
  const handleCreateVariant = useCallback(async () => {
    if (!orgId || !workItemId || !selectedConnectionId || !latest || !variantText) return;
    setCreatingVariant(true);
    setCreateVariantResult(null);
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgId}/channel-posts/drafts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          work_item_id: workItemId,
          connection_id: selectedConnectionId,
          text: variantText,
          link_url: publication?.url ?? null,
          source_content_item_id: draftId,
        }),
      });
      if (res.ok) {
        const json = (await res.json().catch(() => null)) as { data?: { draft_id: string } } | null;
        if (json?.data?.draft_id) {
          router.push(`/content/channel-posts/${json.data.draft_id}`);
          return;
        }
      }
      const body = await res.json().catch(() => null);
      const info = parseSitePostApiError(body);
      setCreateVariantResult({
        type: 'error',
        text: info.humanMessageKey ? t(info.humanMessageKey) : (info.humanMessageFallback || t('channelPostsCreateVariantFailed')),
        raw: info.raw,
      });
    } catch {
      setCreateVariantResult({ type: 'error', text: t('channelPostsCreateVariantFailed') });
    } finally {
      setCreatingVariant(false);
    }
  }, [orgId, workItemId, selectedConnectionId, latest, variantText, publication, draftId, router, t]);

  // story 1db41045(#3457) — 「캠페인 만들기/붙이기」. 새 이름을 입력했으면 먼저
  // POST /campaigns로 만들고(휴먼 전용, BE _require_human — 이 화면은 role을
  // 더 좁히지 않는다, 페드루 PO 정정 2026-09-04 17:03Z), 그 campaign_id로 이
  // 원문을 저장한다(site-posts 저장 POST가 이미 campaign_id를 model_fields_set
  // 캐리포워드로 받는다 — handleSave와 같은 필드 전부 재전송 + campaign_id만
  // 추가). 새 이름이 비어 있으면 select로 고른 기존 campaign_id를 그대로 쓴다.
  const handleAttachCampaign = useCallback(async () => {
    if (!orgId || !latest) return;
    const trimmedName = newCampaignName.trim();
    if (!trimmedName && !selectedCampaignId) return;
    setAttachingCampaign(true);
    setAttachCampaignResult(null);
    try {
      let campaignId = selectedCampaignId;
      if (trimmedName) {
        const createRes = await fetchWithAuth(`/api/organizations/${orgId}/campaigns`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: trimmedName }),
        });
        if (!createRes.ok) {
          const body = await createRes.json().catch(() => null);
          const info = parseSitePostApiError(body);
          setAttachCampaignResult({
            type: 'error',
            text: info.humanMessageKey ? t(info.humanMessageKey) : (info.humanMessageFallback || t('campaignCreateFailed')),
            raw: info.raw,
          });
          return;
        }
        const createJson = (await createRes.json().catch(() => null)) as { data?: { id: string } } | null;
        if (!createJson?.data?.id) {
          setAttachCampaignResult({ type: 'error', text: t('campaignCreateFailed') });
          return;
        }
        campaignId = createJson.data.id;
      }

      // 페드루 PO B1(2026-09-04 17:39Z) — 「붙이기」는 campaign_id만 바꾸는 액션이지
      // "지금 폼에 뭐가 써 있든 그걸로 저장"이 아니다. 에디터 상태(title/summary/
      // bodyMd/tagsText)를 쓰면 미저장 편집이 붙이기 클릭 한 번에 같이 굳어 버린다
      // — latest(이미 저장된 값) 그대로 재전송해 campaign_id 하나만 바뀌게 한다.
      // media_manifest — 이 화면엔 미디어 입력 자체가 없다(handleSave도 항상 []).
      const res = await fetchWithAuth(`/api/organizations/${orgId}/site-posts/drafts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          work_item_id: latest.source_story_id, slug: latest.slug, lang: latest.lang,
          title: latest.title, summary: latest.summary, tags: latest.tags, body_md: latest.body_md,
          media_manifest: [],
          campaign_id: campaignId,
        }),
      });
      if (res.ok) {
        setNewCampaignName('');
        setSelectedCampaignId('');
        setChangingCampaign(false);
        const versionsRes = await fetchWithAuth(`/api/organizations/${orgId}/site-posts/drafts/${draftId}/versions`);
        if (versionsRes.ok) {
          const json = (await versionsRes.json().catch(() => null)) as { data?: SitePostVersion[] } | null;
          if (json?.data) setVersions(json.data);
        }
        void loadCampaigns();
      } else {
        const body = await res.json().catch(() => null);
        const info = parseSitePostApiError(body);
        setAttachCampaignResult({
          type: 'error',
          text: info.humanMessageKey ? t(info.humanMessageKey) : (info.humanMessageFallback || t('campaignAttachFailed')),
          raw: info.raw,
        });
      }
    } catch {
      setAttachCampaignResult({ type: 'error', text: t('campaignAttachFailed') });
    } finally {
      setAttachingCampaign(false);
    }
  }, [orgId, latest, newCampaignName, selectedCampaignId, draftId, loadCampaigns, t]);

  // 페드루 PO B2 — 「해제」. campaign_id: null을 명시로 보낸다(model_fields_set
  // 캐리포워드 계약 — 생략=유지·명시 null=해제, 이미 attach가 확認한 계약 그대로).
  // B1과 같은 이유로 latest(저장본) 필드를 그대로 재전송한다.
  const handleDetachCampaign = useCallback(async () => {
    if (!orgId || !latest) return;
    setDetachingCampaign(true);
    setDetachCampaignResult(null);
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgId}/site-posts/drafts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          work_item_id: latest.source_story_id, slug: latest.slug, lang: latest.lang,
          title: latest.title, summary: latest.summary, tags: latest.tags, body_md: latest.body_md,
          media_manifest: [],
          campaign_id: null,
        }),
      });
      if (res.ok) {
        const versionsRes = await fetchWithAuth(`/api/organizations/${orgId}/site-posts/drafts/${draftId}/versions`);
        if (versionsRes.ok) {
          const json = (await versionsRes.json().catch(() => null)) as { data?: SitePostVersion[] } | null;
          if (json?.data) setVersions(json.data);
        }
      } else {
        const body = await res.json().catch(() => null);
        const info = parseSitePostApiError(body);
        setDetachCampaignResult({
          type: 'error',
          text: info.humanMessageKey ? t(info.humanMessageKey) : (info.humanMessageFallback || t('campaignDetachFailed')),
          raw: info.raw,
        });
      }
    } catch {
      setDetachCampaignResult({ type: 'error', text: t('campaignDetachFailed') });
    } finally {
      setDetachingCampaign(false);
    }
  }, [orgId, latest, draftId, t]);

  // story #3385(Phase0 결함) — 상신 성공 뒤 칩·안내박스·발행버튼이 리로드 전까지 이전
  // 상태로 남던 결함. 원인: 이 조회를 useEffect 안에서만 정의해 뒀던 것 — 승인 요청·저장·
  // 발행 핸들러의 성공 분기가 파생 입력(gate)을 다시 읽을 방법 자체가 없었다(로컬 state를
  // 손으로 지어내는 대신 서버를 다시 물어 진짜 상태를 받는다 — no-fiction). useCallback으로
  // 뽑아 마운트 시 useEffect와 각 핸들러 성공 분기 양쪽에서 부른다.
  const loadGate = useCallback(async () => {
    if (!orgId || !workItemId) return;
    try {
      const res = await fetchWithAuth(`/api/gates?work_item_id=${workItemId}&work_item_type=story`);
      if (!res.ok) return;
      const list = (await res.json().catch(() => [])) as GateInfo[];
      const candidates = Array.isArray(list) ? list : [];
      // doc-gate-section.tsx::load()와 동형 관례 — 반려/대기 중인 게이트를 우선(진행
      // 상태가 있는 쪽이 사용자에게 더 중요), 없으면 최신(배열 첫 항목, 서버가
      // created_at desc로 준다는 기존 게이트 목록 관례 그대로).
      const picked = candidates.find((g) => g.status === 'pending' || g.status === 'rejected') ?? candidates[0] ?? null;
      setGate(picked);
    } catch {
      // best-effort — 게이트 조회 실패는 상태를 'draft'로 안전하게 떨어뜨릴 뿐 화면
      // 전체를 막지 않는다(목록/편집 자체는 게이트 유무와 무관하게 동작해야 함).
    }
  }, [orgId, workItemId]);

  // story #3386 — 원인 진단이 지목한 그 자리(FE가 hasPublishedSitePost를 undefined로
  // 고정해 두던 계약 갭)를 여기서 채운다. best-effort(gate 조회와 동형) — 실패해도
  // publication=null(=모른다)로 남을 뿐 화면 전체를 막지 않는다.
  //
  // story #3385(PO 병합 지시 2026-09-03 13:23Z) — loadGate와 같은 이유로 useCallback화:
  // «발행됨→재승인 필요» 전환도 저장·상신·발행 성공 뒤 리로드 없이 보여야 한다(AC1 「상태를
  // 바꾸는 모든 액션 뒤 파생 입력을 다시 읽는다」는 gate 하나만의 규칙이 아니다).
  const loadPublication = useCallback(async () => {
    if (!orgId) return;
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgId}/site-posts/drafts/${draftId}/publication`);
      if (!res.ok) {
        setPublication(null);
        return;
      }
      const json = (await res.json().catch(() => null)) as { data?: SitePostPublicationInfo } | null;
      setPublication(json?.data ?? null);
    } catch {
      setPublication(null);
    }
  }, [orgId, draftId]);

  useEffect(() => {
    void loadGate();
    void loadPublication();
  }, [loadGate, loadPublication]);

  // gates/[id]/page.tsx:110-127과 동형 — published_by_member_id별로 한 번만 시도(ref로
  // 추적, 응답 목록에 없는 id면 setMemberNames가 매번 새 객체를 만들어 무한 재실행되는
  // 사전 버그를 그쪽에서 이미 겪었다).
  const fetchedPublisherIdRef = useRef<string | null>(null);
  useEffect(() => {
    const id = publication?.published_by_member_id;
    if (!id || fetchedPublisherIdRef.current === id) return;
    fetchedPublisherIdRef.current = id;
    void fetchWithAuth('/api/team-members')
      .then((r) => (r.ok ? r.json() : null))
      .then((json: { data?: { id: string; name: string }[] } | null) => {
        if (!json?.data) return;
        const names: Record<string, string> = {};
        for (const m of json.data) names[m.id] = m.name;
        setMemberNames((prev) => ({ ...prev, ...names }));
      })
      .catch(() => { /* non-critical — id 스니펫 폴백으로 graceful */ });
  }, [publication?.published_by_member_id]);

  // story #3368 §3-1-2(페드루 PO 정정 2026-09-03 06:42Z) — 재승인 필요는 gate.
  // reapproval_required(서버 판정)를 그대로 읽는다. sealed_content_sha256은 이제 approved
  // 분기의 방어망 전용(정상 경로로는 도달 불가 — gates.py 가드가 이중 차단)이다.
  // publishable·blockedReason은 status와 다른 축: approved인데 봉인 값이 없어 "확인 불가"
  // 인 경우도 status는 approved로 남고 publishable만 false다(SEAL_MISSING).
  //
  // story #3386 — hasPublishedSitePost는 이제 undefined 고정이 아니다: publication이
  // 아직 안 왔거나(undefined) 조회가 실패했으면(null) 여전히 undefined(=모른다, AC6)로
  // 넘기고, 실제로 온 뒤에야 published_at!=null로 판정한다. publishedBodySha256도 같은
  // 축(재발행 가능 여부, AC2).
  const { status: derivedStatus, publishable, isRepublish, blockedReason } = deriveContentPostStatus({
    gateStatus: toGateStatus(gate?.status),
    reapprovalRequired: gate?.reapproval_required,
    sealedBodySha256: realStr(gate?.sealed_content_sha256),
    currentBodySha256: latest?.body_sha256,
    hasPublishedSitePost: publication ? publication.published_at != null : undefined,
    publishedBodySha256: publication ? realStr(publication.published_body_sha256) : undefined,
  });

  const handleSave = async () => {
    if (!orgId || !latest) return;
    setSaving(true);
    setSaveMessage(null);
    try {
      const tags = tagsText.split(',').map((s) => s.trim()).filter(Boolean);
      const res = await fetchWithAuth(`/api/organizations/${orgId}/site-posts/drafts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          work_item_id: latest.source_story_id,
          slug: latest.slug, // 잠김 — 항상 기존 값 그대로 재전송(서버 매칭 키).
          lang: latest.lang, // 잠김 — 동일.
          title, summary, tags, body_md: bodyMd, media_manifest: [],
        }),
      });
      if (res.ok) {
        setSaveMessage({ type: 'success', text: t('editSaved') });
        // 새 버전이 생겼다 — 이력을 다시 읽어 새 버전 번호·"미상신" 상태를 반영한다(AC2).
        const versionsRes = await fetchWithAuth(`/api/organizations/${orgId}/site-posts/drafts/${draftId}/versions`);
        if (versionsRes.ok) {
          const json = (await versionsRes.json().catch(() => null)) as { data?: SitePostVersion[] } | null;
          if (json?.data) setVersions(json.data);
        }
        // story #3385(AC1)+#3386 — approved 게이트를 편집하면 서버가 즉시 pending+
        // reapproval_required로 되돌린다(§3-1-2-1). 게이트뿐 아니라 발행 블록도 같은 훅으로
        // 묶는다(PO 2026-09-03 13:23Z) — 저장도 "상태를 바꾸는 액션"이다.
        void loadGate();
        void loadPublication();
      } else {
        const body = await res.json().catch(() => null);
        const info = parseSitePostApiError(body);
        setSaveMessage({
          type: 'error',
          text: info.humanMessageKey ? t(info.humanMessageKey) : (info.humanMessageFallback || t('editSaveFailed')),
          raw: info.raw,
        });
      }
    } catch {
      setSaveMessage({ type: 'error', text: t('editSaveFailed') });
    } finally {
      setSaving(false);
    }
  };

  // story #3368 — 승인 요청(S5) 계약 stub(페드루 PO 판정 2026-09-03). 디디군 S2 착지 전까지
  // 404가 정상 응답이다 — 그 경우도 다른 에러와 동일하게 "사람 말+원문 보존"으로 렌더한다
  // (지어낸 성공 메시지로 덮지 않는다, AC7).
  const handleSubmitForApproval = async () => {
    if (!orgId || !latest) return;
    setSubmitting(true);
    setSubmitResult(null);
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgId}/site-posts/drafts/${draftId}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version_id: latest.version_id }),
      });
      if (res.ok) {
        const json = (await res.json().catch(() => null)) as { data?: { gate_id?: string } } | null;
        const gateId = json?.data?.gate_id;
        if (gateId) {
          setSubmitResult({ type: 'success', gateId });
          // story #3385(핵심 회귀)+#3386 — 서버 게이트는 이미 pending인데 화면은 리로드
          // 전까지 이전 상태(초안·재승인 필요)를 그대로 보였다. 상신 직후 두 파생 입력을
          // 함께 다시 읽는다(PO 2026-09-03 13:23Z — 같은 훅으로 묶는다).
          void loadGate();
          void loadPublication();
        } else {
          setSubmitResult({ type: 'error', text: t('submitFailed'), raw: JSON.stringify(json) });
        }
      } else {
        const body = await res.json().catch(() => null);
        const info = parseSitePostApiError(body);
        // story f6d14476(AC3) — SITE_POST_GATE_ALREADY_HELD 전용 분기. 서버는 상대 초안의
        // draft_id·lang·slug만 준다(title 없음) — 여기서 그 초안의 최신 버전을 별도
        // 조회해 제목을 채운다(best-effort, gates/[id]/page.tsx의 memberNames 관례와 동형
        // — 실패해도 slug/id 폴백으로 문구는 그대로 그린다, 지어내지 않되 화면을 막지도
        // 않는다).
        if (info.kind === 'gate_already_held' && info.heldByDraftId) {
          let holdingTitle = info.heldBySlug ?? info.heldByDraftId.slice(0, 8);
          try {
            const vRes = await fetchWithAuth(
              `/api/organizations/${orgId}/site-posts/drafts/${info.heldByDraftId}/versions`,
            );
            if (vRes.ok) {
              const vJson = (await vRes.json().catch(() => null)) as { data?: SitePostVersion[] } | null;
              const vLatest = vJson?.data?.[vJson.data.length - 1];
              if (vLatest?.title) holdingTitle = vLatest.title;
            }
          } catch {
            // best-effort — 조회 실패는 위 폴백 문구로 graceful.
          }
          setSubmitResult({
            type: 'error',
            text: t('errorGateAlreadyHeld', { title: holdingTitle, lang: info.heldByLang ?? '—' }),
            raw: info.raw,
            heldByDraftId: info.heldByDraftId,
          });
        } else {
          setSubmitResult({
            type: 'error',
            text: info.humanMessageKey ? t(info.humanMessageKey) : (info.humanMessageFallback || t('submitFailed')),
            raw: info.raw,
          });
        }
      }
    } catch {
      setSubmitResult({ type: 'error', text: t('submitFailed') });
    } finally {
      setSubmitting(false);
    }
  };

  // story #3368 §8-1 5단(와이어프레임 S7·S8)/#3369(S3) — 발행. canPublish===true일 때만
  // 호출 가능하게 UI가 막지만(아래 렌더), 서버(site_posts.py::publish_site_post_from_draft)
  // 가 최종 판정이다 — 화면 판단은 안내이지 방어가 아니다(§3-2).
  //
  // ⚠️페드루 PO 리뷰 정정(2026-09-03) — 레거시 `POST /organizations/{org}/site-posts`
  // (호출자가 본문 전체를 다시 보내는 agent 스크립트 시대 API, work_item_id/title/body_md
  // 등을 여기서 재조립)로 잘못 가고 있었다. 휴먼 발행은 draft 기반 신규 endpoint
  // (`.../drafts/{draftId}/publish`, S3)로 가야 한다 — 서버가 draft_id 하나로 최신 버전을
  // 직접 읽어 봉인을 재검증하므로 body가 필요 없다(화면이 본문을 다시 보낼수록 위조·구버전
  // 발행 위험만 는다). 성공 응답 {url, published_at, version_id}의 url은 이제 항상 온다
  // (S3 계약) — 지어내거나 옵셔널로 방어할 필요가 없다.
  const handlePublish = async () => {
    if (!orgId || !latest) return;
    setPublishing(true);
    setPublishResult(null);
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgId}/site-posts/drafts/${draftId}/publish`, {
        method: 'POST',
      });
      if (res.ok) {
        const json = (await res.json().catch(() => null)) as
          { data?: { url?: string; published_at?: string; version_id?: string } } | null;
        const publishedAt = json?.data?.published_at;
        const url = json?.data?.url;
        if (publishedAt && url) {
          setPublishResult({ type: 'success', publishedAt, url });
          // story #3385(AC1)+#3386 — 발행 뒤에도 같은 규칙: 두 파생 입력을 함께 다시 읽는다
          // (PO 병합 지시 2026-09-03 13:23Z — «발행됨→재승인 필요» 전환도 리로드 없이 보여야
          // gate·publication이 같은 화면에서 서로 어긋나지 않는다).
          void loadGate();
          void loadPublication();
        } else {
          setPublishResult({ type: 'error', text: t('publishFailed'), raw: JSON.stringify(json) });
        }
      } else {
        const body = await res.json().catch(() => null);
        const info = parseSitePostApiError(body);
        setPublishResult({
          type: 'error',
          text: info.humanMessageKey ? t(info.humanMessageKey) : (info.humanMessageFallback || t('publishFailed')),
          raw: info.raw,
          reapprovalHashes: info.kind === 'reapproval_required'
            ? { sealed: sealedHash, current: latest.body_sha256 }
            : undefined,
        });
      }
    } catch {
      setPublishResult({ type: 'error', text: t('publishFailed') });
    } finally {
      setPublishing(false);
    }
  };

  // story #3386(AC1 참고 — S8이 이 스토리와 짝인 story #3381/PR#3739의 엔드포인트를 부르는
  // 것까지 요구) — 발행 취소. ConfirmDialog(story #2416 — native confirm() 금지)로 확인
  // 받은 뒤에만 호출한다. 성공하면 publication을 다시 읽어 URL·버튼 상태가 즉시 반영되게
  // 한다(페이지 새로고침 없이).
  const handleUnpublish = async () => {
    if (!orgId) return;
    setUnpublishConfirmOpen(false);
    setUnpublishing(true);
    setUnpublishResult(null);
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgId}/site-posts/drafts/${draftId}/unpublish`, {
        method: 'POST',
      });
      if (res.ok) {
        setUnpublishResult({ type: 'success' });
        void loadPublication();
      } else {
        const body = await res.json().catch(() => null);
        const info = parseSitePostApiError(body);
        setUnpublishResult({
          type: 'error',
          text: info.humanMessageKey ? t(info.humanMessageKey) : (info.humanMessageFallback || t('unpublishFailed')),
          raw: info.raw,
        });
      }
    } catch {
      setUnpublishResult({ type: 'error', text: t('unpublishFailed') });
    } finally {
      setUnpublishing(false);
    }
  };

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-4 p-6">
        <div className="h-8 w-1/2 animate-pulse rounded-md bg-muted" />
        <div className="h-64 animate-pulse rounded-md bg-muted" />
      </div>
    );
  }

  if (loadError || !latest) {
    return (
      <div className="mx-auto w-full max-w-3xl p-6">
        <Alert variant="destructive" role="alert" aria-live="assertive" aria-atomic="true">
          <AlertDescription>{t('editLoadFailed')}</AlertDescription>
        </Alert>
      </div>
    );
  }

  const status = derivedStatus;
  const canPublish = publishable;
  const sealedHash = realStr(gate?.sealed_content_sha256);
  // 페드루 PO 리뷰(2026-09-03) — [82d79b81] AC: "owner/admin만 활성 · member는 비활성 +
  // 이유 문구(버튼 밖)". 서버 403(SITE_POST_UNPUBLISH_OWNER_OR_ADMIN_ONLY)은 방어이지
  // 안내가 아니다 — settings/page.tsx:330·org-members-section.tsx:343와 같은 role 소스
  // (useDashboardContext().role)를 재사용한다, 새 조회를 만들지 않는다.
  const canUnpublish = role === 'owner' || role === 'admin';
  const publisherName = publication?.published_by_member_id
    ? memberNames[publication.published_by_member_id] ?? publication.published_by_member_id.slice(0, 8)
    : '—';

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold text-foreground">{t('editTitle')}</h1>
          <StatusChip status={status} />
          <Badge variant="outline">v{latest.version}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {t('editMeta', { slug: latest.slug, lang: latest.lang })}
        </p>
      </div>

      {/* story 1db41045(#3457) — 캠페인. 이미 붙어 있으면(campaign_id) 이름+상세
          링크·「변경」·「해제」(페드루 PO B2 — 붙인 뒤에도 편집 표면이 있어야
          한다). 「변경」을 누르면 changingCampaign=true로 같은 붙이기 폼을 다시
          연다(새 컴포넌트 0). campaign_id가 없거나 변경 중이면 폼. */}
      {latest.campaign_id && !changingCampaign ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground" data-testid="content-campaign-current">
          <span>
            {t('campaignCurrentLabel')}{' '}
            <Link href={`/campaigns/${latest.campaign_id}`} className="underline">
              {/* N1(페드루 PO) — campaign_name이 없을 때 UUID를 사람 문장에 그대로
                  보여주지 않는다(지어내지도, 식별자를 문장으로 위장하지도 않는다). */}
              {latest.campaign_name ?? t('campaignNameUnknown')}
            </Link>
          </span>
          <Button
            type="button" variant="outline" size="sm"
            onClick={() => setChangingCampaign(true)}
            data-testid="content-campaign-change-button"
          >
            {t('campaignChangeCta')}
          </Button>
          <Button
            type="button" variant="outline" size="sm"
            onClick={() => void handleDetachCampaign()}
            disabled={detachingCampaign}
            data-testid="content-campaign-detach-button"
          >
            {detachingCampaign ? t('campaignDetachPendingCta') : t('campaignDetachCta')}
          </Button>
          {detachCampaignResult ? (
            <Alert variant="destructive" role="alert" data-testid="content-campaign-detach-error">
              <AlertDescription>{detachCampaignResult.text}</AlertDescription>
              <RawDetailsToggle raw={detachCampaignResult.raw} label={t('errorRawDetailsToggle')} />
            </Alert>
          ) : null}
        </div>
      ) : (
        <div className="space-y-2 rounded-md border border-border p-3 text-sm" data-testid="content-campaign-attach">
          <p className="text-xs font-medium text-muted-foreground">{t('campaignAttachLabel')}</p>
          <div className="flex flex-wrap items-center gap-2">
            {campaigns.length > 0 ? (
              <select
                value={selectedCampaignId}
                onChange={(e) => { setSelectedCampaignId(e.target.value); if (e.target.value) setNewCampaignName(''); }}
                className="rounded-md border border-border px-2 py-1.5 text-sm"
                data-testid="content-campaign-select"
              >
                <option value="">{t('campaignSelectPlaceholder')}</option>
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            ) : null}
            <input
              type="text"
              value={newCampaignName}
              onChange={(e) => { setNewCampaignName(e.target.value); if (e.target.value) setSelectedCampaignId(''); }}
              placeholder={t('campaignNewNamePlaceholder')}
              className="rounded-md border border-border px-2 py-1.5 text-sm"
              data-testid="content-campaign-new-name-input"
            />
            <Button
              type="button" size="sm"
              onClick={() => void handleAttachCampaign()}
              disabled={(!newCampaignName.trim() && !selectedCampaignId) || attachingCampaign}
              data-testid="content-campaign-attach-button"
            >
              {attachingCampaign ? t('campaignAttachPendingCta') : t('campaignAttachCta')}
            </Button>
            {changingCampaign ? (
              <Button
                type="button" variant="outline" size="sm"
                onClick={() => { setChangingCampaign(false); setNewCampaignName(''); setSelectedCampaignId(''); setAttachCampaignResult(null); }}
                data-testid="content-campaign-cancel-change-button"
              >
                {t('campaignCancelChangeCta')}
              </Button>
            ) : null}
          </div>
          {attachCampaignResult ? (
            <Alert variant="destructive" role="alert" data-testid="content-campaign-attach-error">
              <AlertDescription>{attachCampaignResult.text}</AlertDescription>
              <RawDetailsToggle raw={attachCampaignResult.raw} label={t('errorRawDetailsToggle')} />
            </Alert>
          ) : null}
        </div>
      )}

      {status === 'reapproval_needed' ? (
        // §3-2 — "판정이 아니라 관측이다. 해시 두 개를 나란히 보여주면 사람이 스스로
        // 확인한다." 서버가 이미 게이트로 재승인을 강제한다(S3 착지 後) — 이 배너는
        // 방어가 아니라 안내다.
        <Alert variant="warning" role="status" aria-live="polite" aria-atomic="true">
          <AlertDescription>
            {t('reapprovalNeededNotice')}
            <br />
            <span className="font-mono text-xs">
              {t('reapprovalSealedHash')} {sealedHash ? `${sealedHash.slice(0, 12)}…` : '—'}
              {' · '}
              {t('reapprovalCurrentHash')} {latest.body_sha256.slice(0, 12)}…
            </span>
          </AlertDescription>
        </Alert>
      ) : null}

      {/* story #3386 AC1·AC3 — 공개 URL·발행 시각·행위자. status와 무관하게 publication이
          있으면 보인다(AC3 "상태와 공개 여부는 두 축" — reapproval_needed여도 옛 버전은
          여전히 공개 중이다). */}
      {publication?.published_at ? (
        <div
          data-testid="content-publication-info"
          className="space-y-1 rounded-md border border-border bg-muted/30 p-3 text-sm"
        >
          <div>
            <span className="text-xs font-medium text-muted-foreground">{t('publishedInfoUrlLabel')}</span>{' '}
            {publication.url ? (
              <a href={publication.url} target="_blank" rel="noopener noreferrer" className="underline">
                {publication.url}
              </a>
            ) : (
              '—'
            )}
          </div>
          <div>
            <span className="text-xs font-medium text-muted-foreground">{t('publishedInfoAtLabel')}</span>{' '}
            {new Date(publication.published_at).toLocaleString()}
          </div>
          <div>
            <span className="text-xs font-medium text-muted-foreground">{t('publishedInfoByLabel')}</span>{' '}
            {publisherName}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setUnpublishConfirmOpen(true)}
            disabled={!canUnpublish || unpublishing}
          >
            {unpublishing ? t('unpublishingCta') : t('unpublishCta')}
          </Button>
          {!canUnpublish ? (
            <p className="text-xs text-muted-foreground">{t('unpublishDisabledReason')}</p>
          ) : null}
        </div>
      ) : null}

      {/* story 15e481ce(#3453 AC1) — 「Threads 변형 만들기」. 활성 연결이 0건이면 이
          자리 자체를 안 그린다(유나 §13-4 "없는 자리를 그리지 않는다" — 비활성 버튼은
          "곧 됩니다"로 읽힌다). */}
      {activeConnections.length > 0 ? (
        <div className="space-y-2 rounded-md border border-border p-3 text-sm" data-testid="content-create-variant">
          <p className="text-xs font-medium text-muted-foreground">{t('channelPostsCreateVariantLabel')}</p>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={selectedConnectionId}
              onChange={(e) => setSelectedConnectionId(e.target.value)}
              className="rounded-md border border-border px-2 py-1.5 text-sm"
              data-testid="content-create-variant-connection-select"
            >
              <option value="">{t('channelPostsCreateVariantSelectPlaceholder')}</option>
              {activeConnections.map((c) => (
                <option key={c.id} value={c.id}>
                  {(c.channel === 'threads' ? t('channelThreads') : c.channel)}
                  {c.account_label ? ` · ${c.account_label}` : ''}
                </option>
              ))}
            </select>
            <Button
              type="button" size="sm"
              onClick={() => void handleCreateVariant()}
              disabled={!selectedConnectionId || creatingVariant || variantTextEmpty}
              data-testid="content-create-variant-button"
            >
              {creatingVariant ? t('channelPostsCreateVariantPendingCta') : t('channelPostsCreateVariantCta')}
            </Button>
          </div>
          {variantTextEmpty ? (
            <p className="text-xs text-muted-foreground" data-testid="content-create-variant-text-empty-reason">
              {t('channelPostsCreateVariantTextEmptyReason')}
            </p>
          ) : null}
          {createVariantResult ? (
            <Alert variant="destructive" role="alert" data-testid="content-create-variant-error">
              <AlertDescription>{createVariantResult.text}</AlertDescription>
              <RawDetailsToggle raw={createVariantResult.raw} label={t('errorRawDetailsToggle')} />
            </Alert>
          ) : null}
        </div>
      ) : null}

      {/* story 15e481ce(#3453 AC2, 유나 §14-2) — "같은 스토리의 채널 글"(역방향). 비어
          있으면 그 자리 자체를 안 그린다. */}
      {variants.length > 0 ? (
        <div className="space-y-2 rounded-md border border-border p-3 text-sm" data-testid="content-variants-list">
          <p className="text-xs font-medium text-muted-foreground">
            {t('channelPostsVariantsListLabel')} ({variants.length})
          </p>
          <ul className="space-y-1.5">
            {variants.map((v) => {
              // 유나 사전 스티어③ — 같은 채널 계정이 둘이면 채널명만으론 안 갈린다.
              // activeConnections(이미 든 값)에서 connection_id로 잇는다 — 못 이으면
              // (연결이 회수됐거나 비활성) 채널명만(지어내지 않는다).
              const accountLabel = activeConnections.find((c) => c.id === v.connection_id)?.account_label;
              return (
                <li key={v.draft_id} className="flex items-center justify-between gap-2" data-testid="content-variants-list-item">
                  <Link href={`/content/channel-posts/${v.draft_id}`} className="underline">
                    {v.channel === 'threads' ? t('channelThreads') : v.channel}
                    {accountLabel ? ` · ${accountLabel}` : ''}
                  </Link>
                  <span className="flex items-center gap-2">
                    {v.published_at ? (
                      <span className="text-xs text-muted-foreground" data-testid="content-variants-list-item-published-at">
                        {formatScheduledAt(v.published_at, displayTimezone).display}
                      </span>
                    ) : null}
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
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <ConfirmDialog
        open={unpublishConfirmOpen}
        onOpenChange={setUnpublishConfirmOpen}
        title={t('unpublishConfirmTitle')}
        description={t('unpublishConfirmDescription')}
        cancelLabel={t('unpublishConfirmCancel')}
        confirmLabel={t('unpublishConfirmAction')}
        onConfirm={() => void handleUnpublish()}
      />

      {unpublishResult && (
        <Alert
          variant={unpublishResult.type === 'success' ? 'success' : 'destructive'}
          role={unpublishResult.type === 'success' ? 'status' : 'alert'}
          aria-live={unpublishResult.type === 'success' ? 'polite' : 'assertive'}
          aria-atomic="true"
        >
          <AlertDescription>
            {unpublishResult.type === 'success' ? t('unpublishSuccess') : unpublishResult.text}
          </AlertDescription>
          {unpublishResult.type === 'error' ? <RawDetailsToggle raw={unpublishResult.raw} label={t('errorRawDetailsToggle')} /> : null}
        </Alert>
      )}

      {saveMessage && (
        <Alert
          variant={saveMessage.type === 'success' ? 'success' : 'destructive'}
          role={saveMessage.type === 'success' ? 'status' : 'alert'}
          aria-live={saveMessage.type === 'success' ? 'polite' : 'assertive'}
          aria-atomic="true"
        >
          <AlertDescription>{saveMessage.text}</AlertDescription>
          {saveMessage.type === 'error' ? <RawDetailsToggle raw={saveMessage.raw} label={t('errorRawDetailsToggle')} /> : null}
        </Alert>
      )}

      {submitResult && (
        <Alert
          variant={submitResult.type === 'success' ? 'success' : 'destructive'}
          role={submitResult.type === 'success' ? 'status' : 'alert'}
          aria-live={submitResult.type === 'success' ? 'polite' : 'assertive'}
          aria-atomic="true"
        >
          <AlertDescription>
            {submitResult.type === 'success' ? (
              <>
                {t('submitSuccess')}{' '}
                <Link href={`/gates/${submitResult.gateId}`} className="underline">{t('submitGateLink')}</Link>
              </>
            ) : submitResult.heldByDraftId ? (
              <>
                {submitResult.text}{' '}
                <Link href={`/content/${submitResult.heldByDraftId}`} className="underline">
                  {t('errorGateAlreadyHeldLink')}
                </Link>
              </>
            ) : (
              submitResult.text
            )}
          </AlertDescription>
          {submitResult.type === 'error' ? <RawDetailsToggle raw={submitResult.raw} label={t('errorRawDetailsToggle')} /> : null}
        </Alert>
      )}

      <div className="space-y-4">
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="post-title">{t('fieldTitle')}</label>
          <input
            id="post-title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={saving}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
          />
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="post-summary">{t('fieldSummary')}</label>
          <input
            id="post-summary"
            type="text"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            disabled={saving}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
          />
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="post-tags">{t('fieldTags')}</label>
          <input
            id="post-tags"
            type="text"
            value={tagsText}
            onChange={(e) => setTagsText(e.target.value)}
            disabled={saving}
            placeholder={t('fieldTagsPlaceholder')}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
          />
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="post-body">{t('fieldBody')}</label>
          <textarea
            id="post-body"
            value={bodyMd}
            onChange={(e) => setBodyMd(e.target.value)}
            disabled={saving}
            rows={16}
            className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm text-foreground"
          />
        </div>

        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">{t('fieldSlugLangLocked')}</p>
          <p className="text-sm text-muted-foreground">{latest.slug} · {latest.lang}</p>
          <p className="text-xs text-muted-foreground">{t('fieldSlugLangLockedHint')}</p>
        </div>

        <div className="flex flex-wrap gap-6">
          {/* 유나 §6-3-1 지적(2026-09-03 라이브 검수) — 목록엔 원작성·최종수정 둘 다 있는데
              편집 화면엔 최종수정만 있어 "원안이 에이전트였다"가 편집 중 안 보였다. */}
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">{t('fieldOriginAuthor')}</p>
            <AuthorKindBadge kind={versions[0]?.author_kind} />
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">{t('fieldLastEditedBy')}</p>
            <AuthorKindBadge kind={latest.author_kind} />
          </div>
        </div>

        <div className="space-y-1">
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => void handleSave()} disabled={saving}>
              {saving ? t('editSavingCta') : t('editSaveCta')}
            </Button>
            <Button type="button" variant="outline" onClick={() => void handleSubmitForApproval()} disabled={saving || submitting}>
              {submitting ? t('submitPendingCta') : t('submitCta')}
            </Button>
            {/* story #3386 AC2 — 발행된 글은 기본 잠금(canPublish=false), 재승인된 새
                버전이 있을 때만(isRepublish) 다시 열리고 라벨이 「재발행」으로 바뀐다. */}
            <Button type="button" variant="outline" onClick={() => void handlePublish()} disabled={!canPublish || publishing}>
              {publishing
                ? (isRepublish ? t('publishRepublishingCta') : t('publishPendingCta'))
                : (isRepublish ? t('publishRepublishCta') : t('publishCta'))}
            </Button>
          </div>
          {/* §6-2-1 — 비활성 발행 버튼 라벨 자체는 WCAG 면제 대상이지만, "눌리지 않는
              이유"를 옆에 두는 이 문구는 실제 정보라 4.5:1 판정 대상이다(text-muted-
              foreground on card 실측 5.92 — 통과, doc §6-2-1 그대로). */}
          {!canPublish ? (
            <p className="text-xs text-muted-foreground">
              {blockedReason === 'SEAL_MISSING'
                ? t('publishDisabledReasonSealMissing')
                : status === 'published'
                  ? t('publishDisabledReasonAlreadyPublished')
                  : t('publishDisabledReason')}
            </p>
          ) : null}
        </div>
      </div>

      {publishResult && (
        <Alert
          variant={publishResult.type === 'success' ? 'success' : 'destructive'}
          role={publishResult.type === 'success' ? 'status' : 'alert'}
          aria-live={publishResult.type === 'success' ? 'polite' : 'assertive'}
          aria-atomic="true"
        >
          <AlertDescription>
            {publishResult.type === 'success' ? (
              <>
                {t('publishSuccess', { time: new Date(publishResult.publishedAt).toLocaleString() })}
                {' '}
                <a href={publishResult.url} target="_blank" rel="noopener noreferrer" className="underline">
                  {t('publishViewLink')}
                </a>
              </>
            ) : (
              <>
                {publishResult.text}
                {publishResult.reapprovalHashes ? (
                  // §8-3④-1 — 409 SITE_POST_REAPPROVAL_REQUIRED는 S10 일반 오류가 아니라
                  // S9와 같은 처리(문구+해시 병치)다. 판정이 아니라 관측(§3-2)이라 여기서도
                  // 그대로 — 해시 두 개를 나란히 보여주고 사람이 스스로 확인하게 한다.
                  <>
                    <br />
                    <span className="font-mono text-xs">
                      {t('reapprovalSealedHash')} {publishResult.reapprovalHashes.sealed ? `${publishResult.reapprovalHashes.sealed.slice(0, 12)}…` : '—'}
                      {' · '}
                      {t('reapprovalCurrentHash')} {publishResult.reapprovalHashes.current.slice(0, 12)}…
                    </span>
                  </>
                ) : null}
              </>
            )}
          </AlertDescription>
          {publishResult.type === 'error' ? <RawDetailsToggle raw={publishResult.raw} label={t('errorRawDetailsToggle')} /> : null}
        </Alert>
      )}
    </div>
  );
}
