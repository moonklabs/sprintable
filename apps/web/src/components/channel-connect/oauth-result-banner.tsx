'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { connectErrorLabelKey } from '@/components/channel-connect/connect-error';
import { useChannelLabel, channelConnectionIdentityLabel } from '@/lib/channel-label';

/**
 * story #4019(PO 確定 2026-09-17) — OAuth 콜백이 쿼리로 돌려주는 결과(connected·
 * connect_error·error_id·mismatch·updated)를 판정+렌더까지 한 곳에서 맡는다. 레거시
 * organization/channels/page.tsx(:1261-1284 파생·:1348-1380 렌더)와 v3
 * connect-rules-v3-channels.tsx가 각자 다시 그리면 문구·마크업이 갈릴 위험이 있어
 * (재파생만 공유해선 안 됨) — 이 컴포넌트 자체를 두 화면이 마운트해 바이트 동일을
 * 보장한다.
 *
 * AC2 CHANGES(페드루 PO 확定 2026-09-17 16:05Z) — "레거시 동작과 같게(반복 허용)"는
 * PO 전제가 틀린 문장이었다(레거시에 URL cleanup 자체가 없었음, 재측으로 정정) — 이제
 * **두 화면 다** 표시 뒤 결과 인자를 지워 새로고침 반복을 0으로 만든다. 조건 4가지:
 *  ① 인자를 먼저 state로 캡처하고 나서 URL을 고친다(고치는 순간 곧바로 안내가
 *     사라지면 안 됨 — 판정이 searchParams 직접 파생이면 지우자마자 꺼짐).
 *  ② mismatch 대상 연결은 id만 캡처해 두고, 렌더 시점에 매번 connections prop과
 *     대조한다(목록이 늦게 도착해도 나중 렌더에서 뜸 — 캡처 시점에 즉시 resolve하지
 *     않는다).
 *  ③ RESULT_PARAM_KEYS 5개만 지운다 — 같은 화면이 select_pending·pending_id·
 *     candidates도 쿼리로 받으므로 보존.
 *  ④ router.replace(..., { scroll: false }) — 히스토리 새 항목 0·스크롤 0.
 */
const RESULT_PARAM_KEYS = ['connected', 'connect_error', 'error_id', 'mismatch', 'updated'] as const;

interface CapturedResult {
  connected: string | null;
  connectError: string | null;
  connectErrorId: string | null;
  mismatchTargetId: string | null;
  mismatchUpdatedId: string | null;
}

export interface OAuthResultBannerConnection {
  id: string;
  channel: string;
  // v3(connect-rules-v3-channels.tsx)의 로컬 타입은 이 필드를 optional로 선언해 뒀다
  // (레거시 channel-connect/types.ts는 required) — 같은 BE 응답이라 실질은 항상 있지만,
  // 공유 컴포넌트는 두 타입의 최소공통분모(| undefined 포함)를 받는다.
  account_label?: string | null;
}

export function OAuthResultBanner({
  connections, isOwnerStrict,
}: {
  connections: OAuthResultBannerConnection[];
  isOwnerStrict: boolean;
}) {
  const t = useTranslations('channelConnect');
  const channelLabel = useChannelLabel();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const [captured, setCaptured] = useState<CapturedResult | null>(null);
  const capturedOnce = useRef(false);

  useEffect(() => {
    if (capturedOnce.current) return;
    capturedOnce.current = true;
    const hasAnyResultParam = RESULT_PARAM_KEYS.some((key) => searchParams.get(key) !== null);
    if (!hasAnyResultParam) return;

    // story #3672 — BE unhandled_exception_handler가 실어 준 error_id는 uuid 형식일
    // 때만 표시(조작 가능한 입력 — 손상된 URL에 임의 문자열을 그대로 띄우지 않는다).
    const rawConnectErrorId = searchParams.get('error_id');
    const connectErrorId = rawConnectErrorId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawConnectErrorId)
      ? rawConnectErrorId
      : null;
    setCaptured({
      connected: searchParams.get('connected'),
      connectError: searchParams.get('connect_error'),
      connectErrorId,
      mismatchTargetId: searchParams.get('mismatch'),
      mismatchUpdatedId: searchParams.get('updated'),
    });

    // AC2 조건③④ — 결과 인자 5개만 지운다(select_pending류는 보존), 히스토리 새 항목
    // 0·스크롤 0. 조건① — state 캡처가 이미 끝난 뒤라 안내가 안 꺼진다(다음 렌더는
    // captured state에서 그리지 searchParams를 다시 안 봄).
    const next = new URLSearchParams(searchParams.toString());
    for (const key of RESULT_PARAM_KEYS) next.delete(key);
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 마운트 시 1회 캡처(위 §조건①) 의도, searchParams/router/pathname 재구독 불필요.
  }, []);

  if (!captured) return null;

  const { connected, connectError, connectErrorId, mismatchTargetId, mismatchUpdatedId } = captured;
  // story #3661 — mismatch 파라미터가 있으면 이미 「불일치 재연결」로 확定된 것(plain
  // 성공 배너 대상이 아니다). 대상 연결을 못 찾은 채로(로드 前이든 삭제된 뒤든) raw
  // UUID로 Alert를 그리는 대신 조용히 건너뛴다(조건② — connections가 늦게 와도 이후
  // 렌더에서 자연히 뜬다, 캡처 시점 즉시 resolve 안 함).
  const isMismatchCase = Boolean(connected && mismatchTargetId && mismatchUpdatedId);
  const mismatchTargetConn = connections.find((c) => c.id === mismatchTargetId);
  const mismatchUpdatedConn = connections.find((c) => c.id === mismatchUpdatedId);

  return (
    <>
      {isMismatchCase && mismatchTargetConn && mismatchUpdatedConn ? (
        <Alert variant="info" role="status" aria-live="polite" aria-atomic="true" data-testid="channel-reauth-mismatch-note">
          <AlertDescription>
            {t('channelReauthMismatchNote', {
              updated: channelConnectionIdentityLabel({ ...mismatchUpdatedConn, account_label: mismatchUpdatedConn.account_label ?? null }, channelLabel),
              intended: channelConnectionIdentityLabel({ ...mismatchTargetConn, account_label: mismatchTargetConn.account_label ?? null }, channelLabel),
            })}
          </AlertDescription>
        </Alert>
      ) : connected && !isMismatchCase ? (
        <Alert variant="success" role="status" aria-live="polite" aria-atomic="true">
          <AlertDescription>{t('channelConnectSuccess', { channel: channelLabel(connected) })}</AlertDescription>
        </Alert>
      ) : null}
      {connectError ? (
        <Alert variant="destructive" role="alert" aria-live="assertive" aria-atomic="true">
          {/* story #3504 — CHANNEL_APP_CREDENTIALS_MISSING의 "누구에게 요청하나" 분기는
              app-credentials 등록 자격(owner 전용)을 묻는다 — owner|admin 폭이 아니라
              isOwnerStrict가 맞다. */}
          <AlertDescription>
            {t(connectErrorLabelKey(connectError, isOwnerStrict))}
            {connectErrorId ? (
              // 유나 라이브 픽셀 실측(#4025 리뷰) — AlertDescription 자체가 opacity-90이라
              // 그 안에서 text-muted-foreground는 대비가 하한 미달로 떨어진다.
              // text-foreground로.
              <span className="mt-1 block select-text text-xs text-foreground">
                {t('channelConnectErrorId', { errorId: connectErrorId })}
              </span>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
    </>
  );
}
