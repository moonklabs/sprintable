'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { fetchWithAuth } from '@/lib/db/client';
import { deviceDateOptions } from '@/lib/desktop-devices';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { useOrgRemoteControl, type OrgRemoteControl } from '@/lib/org-remote-control';
import { useViewerTimeZone } from '@/components/viewer-time-zone';

/**
 * story #4535 AC1 (명세 모음 B-1 ① · 유나 09:24Z 자리 확정) — /desktop의 «데스크톱 앱» 카드와 «연결된 기기» 사이 카드 하나.
 * 조직 «원격 제어»: 기본 꺼짐 · 소유자만 스위치(서버 `can_change`) · 그 밖의 사람은 지금 상태를 그대로 말하는 한 줄 ·
 * 켜져 있으면 «{날짜}부터 켜져 있어요» · 끌 때만 줄 안 확인([취소]가 첫 초점) · 바꾸기 실패 = 스위치 되돌림 + 한 줄 ·
 * 403이면 소유자 줄로(스위치 숨김). 끄기 확인이 닫히면([끄기] · [취소]) 초점은 스위치로 돌아가고, 실패 줄은 늘 붙어 있는 빈 status에
 * 글만 채운다(유나 12:43Z — 글을 품은 채 새로 붙는 라이브 영역은 확실히 읽히지 않는다).
 */
type State = OrgRemoteControl;

export function DesktopRemoteControlCard() {
  const t = useTranslations('desktop.remoteControl');
  const { orgId } = useDashboardContext();
  // one value with «원격 기기» (story #4535 · PO 18:58Z): a change here is what that part shows, with no reload
  const [state, setState] = useOrgRemoteControl(orgId);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const switchRef = useRef<HTMLButtonElement>(null);
  const wasAsking = useRef(false);

  // the in-line confirmation closed ([끄기] or [취소]): the focus it held goes back to the switch, not to the page
  useEffect(() => {
    if (wasAsking.current && !asking) switchRef.current?.focus();
    wasAsking.current = asking;
  }, [asking]);

  const change = useCallback(async (enabled: boolean) => {
    if (!orgId || !state) return;
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgId}/remote-control`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }),
      });
      if (res.ok) {
        const next = ((await res.json()) as { data?: State }).data;
        if (next) setState(next);
      } else if (res.status === 403) {
        setState({ ...state, can_change: false }); // not an owner after all: the owner line, no switch
      } else {
        setFailed(true); // the switch stays where it was (the state did not change)
      }
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
      setAsking(false);
    }
  }, [orgId, state, setState]);

  if (!state) return null; // not an org person · not loaded: the page goes on without the card

  return (
    <Card className="break-keep flex flex-col gap-2 p-6" data-testid="desktop-remote-control">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold">{t('title')}</h2>
        {state.can_change ? (
          <Switch
            ref={switchRef}
            checked={state.enabled}
            disabled={busy || asking}
            aria-label={t('title')}
            onCheckedChange={(on) => { if (on) void change(true); else { setFailed(false); setAsking(true); } }}
          />
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground">{t('body')}</p>
      <p className="text-xs text-muted-foreground">{t('allowed')}</p>
      {state.enabled && state.enabled_at ? <EnabledSince at={state.enabled_at} /> : null}
      {!state.can_change ? (
        <p className="text-xs text-muted-foreground" data-testid="desktop-remote-control-owner-only">
          {state.enabled ? t('ownerOnlyOn') : t('ownerOnlyOff')}
        </p>
      ) : null}
      {asking ? <ConfirmOff busy={busy} onConfirm={() => void change(false)} onCancel={() => setAsking(false)} /> : null}
      <p className="text-xs text-destructive" role="status">{failed ? t('failed') : ''}</p>
    </Card>
  );
}

function EnabledSince({ at }: { at: string }) {
  // the same date form as «연결된 기기» right below (deviceDateOptions — no year within this year · Yuna 12:53Z)
  const t = useTranslations('desktop.remoteControl');
  const format = useFormatter();
  const tz = useViewerTimeZone() ?? 'UTC';
  const date = format.dateTime(new Date(at), { ...deviceDateOptions(at, new Date(), tz), timeZone: tz });
  return <p className="text-xs text-muted-foreground">{t('since', { date })}</p>;
}

function ConfirmOff({ busy, onConfirm, onCancel }: { busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  const t = useTranslations('desktop.remoteControl');
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { cancelRef.current?.focus(); }, []); // [취소] first (Yuna B-1 ①)
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-3" role="group" aria-label={t('confirmOff')}>
      <p className="text-sm">{t('confirmOff')}</p>
      <div className="flex gap-2">
        <Button size="sm" variant="destructive" disabled={busy} onClick={onConfirm}>{t('turnOff')}</Button>
        <Button size="sm" variant="outline" ref={cancelRef} disabled={busy} onClick={onCancel}>{t('cancel')}</Button>
      </div>
    </div>
  );
}
