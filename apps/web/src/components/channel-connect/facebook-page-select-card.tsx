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

// story #3549(유나 §13-8②③④, 3547 BE·디디 계약, PO 確定 2026-09-06) — Facebook
// Page 「선택 대기」 얼굴. §13-8 그라운딩 — 새로 짓는 것은 이 카드 하나뿐(연결
// 시작 카드·연결 카드·실패 문구 배선은 전부 기존 것을 그대로 쓴다).
//
// §13-8④ — 「행위가 같으면 같은 낱말」: NOT_FOUND·EXPIRED·FORBIDDEN 셋은 Meta로
// 다시 가서 재승인해야 하니 기존 재인증 낱말(`channelReauthAction`="다시 연결")을
// 새로 짓지 않고 그대로 쓴다. INVALID_PAGE·PROVIDER_UNAVAILABLE 둘은 같은 선택을
// 다시 보내면 되므로 "다시 시도"(서버 message 그대로 보여준다 — 페드루 PO 지시,
// 2026-09-06 — 이 두 코드는 왜 실패했는지가 사람마다 다를 수 있어 고정 문구로
// 뭉치지 않는다).
const RESTART_OAUTH_CODES = new Set([
  'CHANNEL_OAUTH_PENDING_SELECTION_NOT_FOUND',
  'CHANNEL_OAUTH_PENDING_SELECTION_EXPIRED',
  'CHANNEL_OAUTH_PENDING_SELECTION_FORBIDDEN',
]);

export interface FacebookPageSelectCardProps {
  channel: string;
  orgId: string;
  pendingId: string;
  candidates: FacebookPageCandidate[];
  isOwner: boolean;
  onConnected: () => void;
  t: ReturnType<typeof useTranslations>;
}

export function FacebookPageSelectCard({
  channel, orgId, pendingId, candidates, isOwner, onConnected, t,
}: FacebookPageSelectCardProps) {
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // §5-2 규율 그대로(연결 시작과 같은 owner 전용 폭 — authorize_channel_connection이
  // 이미 owner만 통과시키므로 select도 그 연장선). 비활성이 아니라 안 그린다.
  if (!isOwner) {
    return <p className="text-xs text-muted-foreground">{t('channelConnectOwnerOnlyReason', { channel: channelLabel(channel, t) })}</p>;
  }

  // §13-8③ — 0개는 두 원인(관리하는 페이지 없음 / 목록 권한 미승인)을 하나로
  // 뭉치지 않는다. 아는 값만 말하고 지어내지 않는다(§22-15②와 같은 규율).
  if (candidates.length === 0) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="channel-connect-facebook-no-pages">
        {t('channelConnectFacebookNoPages')}
      </p>
    );
  }

  async function handleSelect() {
    if (!selectedPageId) return;
    setSubmitting(true);
    setErrorCode(null);
    setErrorMessage(null);
    try {
      // 디디 PR#3904 실측 — BE select 엔드포인트는 `/channel-connections/facebook/
      // select`로 리터럴 고정이다(channel 세그먼트 없음 — 어느 채널의 pending인지는
      // body.pending_id로 저장된 pending.channel에서 되찾는다). `channel` prop(라벨
      // 표시용)을 URL에 쓰지 않는다 — 이 카드가 나중에 facebook_sandbox까지 재사용돼도
      // 이 호출은 그대로다.
      const res = await fetchWithAuth(`/api/organizations/${orgId}/channel-connections/facebook/select`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pending_id: pendingId, page_id: selectedPageId }),
      });
      if (res.ok) {
        // §13-8② "성공 토스트를 띄우지 않는다 — 카드가 바뀐 것 자체가 결과다".
        // onConnected()가 목록을 다시 부르면 connections.length>0이 되어 부모가
        // 이 카드 대신 연결 행을 그린다(재로드 없이, sandbox 카드와 동형 배선).
        onConnected();
        return;
      }
      const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
      setErrorCode(body?.error?.code ?? null);
      setErrorMessage(body?.error?.message ?? null);
    } catch {
      setErrorCode(null);
      setErrorMessage(null);
    } finally {
      setSubmitting(false);
    }
  }

  if (errorCode) {
    if (RESTART_OAUTH_CODES.has(errorCode)) {
      return (
        <div className="flex flex-col items-start gap-1" data-testid="channel-connect-facebook-select-error">
          <p className="text-xs text-destructive">{t('channelConnectFacebookSelectGone')}</p>
          <a href={`/api/oauth-channel/authorize?org=${orgId}&channel=${channel}`}>
            <Button size="sm" variant="outline">{t('channelReauthAction')}</Button>
          </a>
        </div>
      );
    }
    return (
      <div className="flex flex-col items-start gap-1" data-testid="channel-connect-facebook-select-error">
        <p className="text-xs text-destructive">{errorMessage ?? t('channelConnectErrorGeneric')}</p>
        <Button size="sm" variant="outline" onClick={() => void handleSelect()} disabled={submitting}>
          {t('channelConnectFacebookSelectRetryCta')}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col items-start gap-2" data-testid="channel-connect-facebook-select">
      <p className="text-xs font-medium text-muted-foreground">{t('channelConnectFacebookSelectInstruction')}</p>
      {/* §13-8② "펼친 목록"(접히는 select 아님) — 라디오, 기본 선택 없음, 목록만
          자기 안에서 스크롤(카드가 늘어나 다른 채널을 밀어내지 않는다). */}
      <div
        className="max-h-48 w-full space-y-1 overflow-y-auto"
        role="radiogroup" aria-label={t('channelConnectFacebookSelectInstruction')}
      >
        {candidates.map((c) => (
          <label
            key={c.page_id}
            className="flex cursor-pointer items-center gap-2 rounded-md border border-border p-2 text-sm has-[:checked]:border-primary"
          >
            <input
              type="radio" name={`facebook-page-select-${pendingId}`} value={c.page_id}
              checked={selectedPageId === c.page_id}
              onChange={() => setSelectedPageId(c.page_id)}
            />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-foreground">{c.name}</span>
              {/* §13-8② "이름은 같을 수 있다 — 두 줄을 가를 수 없으면 고를 수
                  없다"·§13-8⑥ 대비 4.5(muted 보조 글자도 이 등급). */}
              <span className="truncate text-xs text-muted-foreground">{c.page_id}</span>
            </span>
          </label>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{t('channelConnectFacebookSelectExpiryNote')}</p>
      <Button
        size="sm" onClick={() => void handleSelect()} disabled={!selectedPageId || submitting}
        data-testid="channel-connect-facebook-select-submit"
      >
        {submitting ? t('channelConnectFacebookSelectSubmitting') : t('channelConnectFacebookSelectSubmitCta')}
      </Button>
    </div>
  );
}
