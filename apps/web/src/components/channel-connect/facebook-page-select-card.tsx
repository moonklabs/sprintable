'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { fetchWithAuth } from '@/lib/db/client';
import { channelLabel } from '@/lib/channel-label';

export interface FacebookPageCandidate {
  page_id: string;
  name: string;
}

// story #3806 PR 7(페드루 PO 確定 2026-09-11) — Meta 광고 계정 후보(meta_ads/
// ads_sandbox). Page와 달리 page_id가 아니라 account_id(backend AdAccountCandidate,
// channel_connections.py). 이 카드가 두 형을 모두 받게 넓힌다(계정 카드를 새로
// 짓지 않는다 — 라디오·에러 3종·owner 게이트 등 나머지 골격은 100% 동형).
export interface AdAccountCandidate {
  account_id: string;
  name: string;
}

export type SelectCandidate = FacebookPageCandidate | AdAccountCandidate;

// story #3549(유나 §13-8②③④, 3547 BE·디디 계약, PO 確定 2026-09-06) — Facebook
// Page 「선택 대기」 얼굴. §13-8 그라운딩 — 새로 짓는 것은 이 카드 하나뿐(연결
// 시작 카드·연결 카드·실패 문구 배선은 전부 기존 것을 그대로 쓴다).
//
// §13-8④(REQUIRED 2, 유나 §13-8④-b 채택·페드루 PO 2026-09-06) — 「행위가 같으면
// 같은 낱말」: NOT_FOUND·EXPIRED·FORBIDDEN 셋은 Meta로 다시 가서 재승인해야 하니
// 기존 재인증 낱말(`channelReauthAction`="다시 연결")을 새로 짓지 않고 그대로 쓴다.
// PROVIDER_UNAVAILABLE(503)·INVALID_PAGE는 원인이 다르니 문장을 가른다(서버
// message는 이제 안 보여준다 — 사람마다 다른 서버 문장 대신 고정 두 문장):
// - 503: 「지금은 연결하지 못했습니다」+ 「다시 시도」(같은 페이지 재시도가 뜻이
//   있다 — 일시적 제공자 오류). 이 화면은 자동 재시도가 없어 §22-15의 "다시 시도"
//   금지 사유(자동 재시도 문장과 충돌)가 성립하지 않는다.
// - INVALID_PAGE: 「그 페이지는 지금 연결할 수 없습니다」+ **선택 해제**(같은
//   page_id로 같은 실패에 돌아가는 버튼을 남기지 않는다) — 재시도 CTA 없이 라디오
//   목록으로 돌아가 다른 페이지를 고르게 한다.
const RESTART_OAUTH_CODES = new Set([
  'CHANNEL_OAUTH_PENDING_SELECTION_NOT_FOUND',
  'CHANNEL_OAUTH_PENDING_SELECTION_EXPIRED',
  'CHANNEL_OAUTH_PENDING_SELECTION_FORBIDDEN',
]);
const PROVIDER_UNAVAILABLE_CODE = 'CHANNEL_OAUTH_PROVIDER_UNAVAILABLE';
const INVALID_PAGE_CODE = 'CHANNEL_OAUTH_PENDING_SELECTION_INVALID_PAGE';
// story #3806 PR 7 — meta_ads/ads_sandbox select(channel_connections.py
// meta_ads_select_account_endpoint)의 대응 코드(Page의 INVALID_PAGE와 동형, 값만
// 다름).
const INVALID_ACCOUNT_CODE = 'CHANNEL_OAUTH_PENDING_SELECTION_INVALID_ACCOUNT';

// story #3806 PR 7 — 이 카드가 보는 채널이 Page(facebook류)인지 광고 계정
// (meta_ads/ads_sandbox)인지는 channel 문자열로만 가른다(isFacebookOauthChannel과
// 동형 판별 축, 호출부 page.tsx와 동일 리터럴 목록).
function isAdAccountChannel(channel: string): boolean {
  return channel === 'meta_ads' || channel === 'ads_sandbox';
}
function candidateId(c: SelectCandidate, adAccount: boolean): string {
  return adAccount ? (c as AdAccountCandidate).account_id : (c as FacebookPageCandidate).page_id;
}

export interface FacebookPageSelectCardProps {
  channel: string;
  orgId: string;
  pendingId: string;
  candidates: SelectCandidate[];
  isOwner: boolean;
  onConnected: () => void;
  t: ReturnType<typeof useTranslations>;
}

export function FacebookPageSelectCard({
  channel, orgId, pendingId, candidates, isOwner, onConnected, t,
}: FacebookPageSelectCardProps) {
  const adAccount = isAdAccountChannel(channel);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  // §5-2 규율 그대로(연결 시작과 같은 owner 전용 폭 — authorize_channel_connection이
  // 이미 owner만 통과시키므로 select도 그 연장선). 비활성이 아니라 안 그린다.
  if (!isOwner) {
    return <p className="text-xs text-muted-foreground">{t('channelConnectOwnerOnlyReason', { channel: channelLabel(channel, t) })}</p>;
  }

  // §13-8③ — 0개는 두 원인(관리하는 페이지/계정 없음 · 목록 권한 미승인)을 하나로
  // 뭉치지 않는다. 아는 값만 말하고 지어내지 않는다(§22-15②와 같은 규율).
  if (candidates.length === 0) {
    return (
      <p
        className="text-xs text-muted-foreground"
        data-testid={adAccount ? 'channel-connect-ad-account-no-accounts' : 'channel-connect-facebook-no-pages'}
      >
        {t(adAccount ? 'channelConnectAdAccountNoAccounts' : 'channelConnectFacebookNoPages')}
      </p>
    );
  }

  const invalidSelectionCode = adAccount ? INVALID_ACCOUNT_CODE : INVALID_PAGE_CODE;

  async function handleSelect() {
    if (!selectedId) return;
    setSubmitting(true);
    setErrorCode(null);
    try {
      // 디디 PR#3904 실측(facebook류) — BE select 엔드포인트는 `/channel-connections/
      // facebook/select`로 리터럴 고정(channel 세그먼트 없음, pending.channel로 어느
      // 채널인지 되찾는다). meta_ads/ads_sandbox는 별도 엔드포인트(`meta-ads/select`,
      // channel_connections.py meta_ads_select_account_endpoint) — 광고 계정은 계정별
      // 토큰이 없어 페이지와 계약이 달라 같은 라우트를 못 탄다(장기 유저 토큰 하나를
      // pending에 그대로 들고 있다가 그 토큰으로 연결 행을 만든다).
      const url = adAccount
        ? `/api/organizations/${orgId}/channel-connections/meta-ads/select`
        : `/api/organizations/${orgId}/channel-connections/facebook/select`;
      const body = adAccount
        ? { pending_id: pendingId, account_id: selectedId }
        : { pending_id: pendingId, page_id: selectedId };
      const res = await fetchWithAuth(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        // §13-8② "성공 토스트를 띄우지 않는다 — 카드가 바뀐 것 자체가 결과다".
        // onConnected()가 목록을 다시 부르면 connections.length>0이 되어 부모가
        // 이 카드 대신 연결 행을 그린다(재로드 없이, sandbox 카드와 동형 배선).
        onConnected();
        return;
      }
      const errBody = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
      const code = errBody?.error?.code ?? null;
      setErrorCode(code);
      if (code === invalidSelectionCode) setSelectedId(null);
    } catch {
      setErrorCode(null);
    } finally {
      setSubmitting(false);
    }
  }

  const errorTestId = adAccount ? 'channel-connect-ad-account-select-error' : 'channel-connect-facebook-select-error';

  if (errorCode && RESTART_OAUTH_CODES.has(errorCode)) {
    return (
      <div className="flex flex-col items-start gap-1" data-testid={errorTestId}>
        <p className="text-xs text-destructive">{t('channelConnectFacebookSelectGone')}</p>
        <a href={`/api/oauth-channel/authorize?org=${orgId}&channel=${channel}`}>
          <Button size="sm" variant="outline">{t('channelReauthAction')}</Button>
        </a>
      </div>
    );
  }
  if (errorCode === PROVIDER_UNAVAILABLE_CODE) {
    return (
      <div className="flex flex-col items-start gap-1" data-testid={errorTestId}>
        <p className="text-xs text-destructive">{t('channelConnectFacebookSelectProviderUnavailable')}</p>
        <Button size="sm" variant="outline" onClick={() => void handleSelect()} disabled={submitting}>
          {t('channelConnectFacebookSelectRetryCta')}
        </Button>
      </div>
    );
  }

  const instructionKey = adAccount ? 'channelConnectAdAccountSelectInstruction' : 'channelConnectFacebookSelectInstruction';

  return (
    <div
      className="flex w-full flex-col items-start gap-2"
      data-testid={adAccount ? 'channel-connect-ad-account-select' : 'channel-connect-facebook-select'}
    >
      {errorCode === invalidSelectionCode ? (
        <p
          className="text-xs text-destructive"
          data-testid={adAccount ? 'channel-connect-ad-account-select-invalid-account' : 'channel-connect-facebook-select-invalid-page'}
        >
          {t(adAccount ? 'channelConnectAdAccountSelectInvalidAccount' : 'channelConnectFacebookSelectInvalidPage')}
        </p>
      ) : null}
      <p className="text-xs font-medium text-muted-foreground">{t(instructionKey)}</p>
      {/* §13-8② "펼친 목록"(접히는 select 아님) — 라디오, 기본 선택 없음, 목록만
          자기 안에서 스크롤(카드가 늘어나 다른 채널을 밀어내지 않는다). p-1은
          verify:focus-inset-coverage(a98b36f4 회귀 가드) 요구 — 스크롤 컨테이너
          안쪽에 포커스 링이 3면 잘리지 않을 여백. */}
      <div
        className="max-h-48 w-full space-y-1 overflow-y-auto p-1"
        role="radiogroup" aria-label={t(instructionKey)}
      >
        {candidates.map((c) => {
          const id = candidateId(c, adAccount);
          return (
          <label
            key={id}
            className="flex cursor-pointer items-center gap-2 rounded-md border border-border p-2 text-sm has-[:checked]:border-primary has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary"
          >
            <input
              type="radio" name={`facebook-page-select-${pendingId}`} value={id}
              checked={selectedId === id}
              onChange={() => { setSelectedId(id); setErrorCode(null); }}
            />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-foreground">{c.name}</span>
              {/* §13-8② "이름은 같을 수 있다 — 두 줄을 가를 수 없으면 고를 수
                  없다"·§13-8⑥ 대비 4.5(muted 보조 글자도 이 등급). */}
              <span className="truncate text-xs text-muted-foreground">{id}</span>
            </span>
          </label>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">{t('channelConnectFacebookSelectExpiryNote')}</p>
      <Button
        size="sm" onClick={() => void handleSelect()} disabled={!selectedId || submitting}
        data-testid={adAccount ? 'channel-connect-ad-account-select-submit' : 'channel-connect-facebook-select-submit'}
      >
        {submitting ? t('channelConnectFacebookSelectSubmitting') : t('channelConnectFacebookSelectSubmitCta')}
      </Button>
    </div>
  );
}
