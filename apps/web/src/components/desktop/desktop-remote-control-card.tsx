'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { Button } from '@/components/ds/button';
import { Card } from '@/components/ds/card';
import { Toggle } from '@/components/ds/toggle';
import { fetchWithAuth } from '@/lib/db/client';
import { deviceDateOptions } from '@/lib/desktop-devices';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { useOrgRemoteControl, type OrgRemoteControl } from '@/lib/org-remote-control';
import { useViewerTimeZone } from '@/components/viewer-time-zone';
import { ARRIVAL_HOLD_MS, formatOwners, holdArrivalFocus, REMOTE_CONTROL_ANCHOR, takeArrival } from '@/components/desktop/remote-off';

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
  const tOff = useTranslations('remoteControlOff');
  const { orgId } = useDashboardContext();
  // one value with «원격 기기» (story #4535 · PO 18:58Z): a change here is what that part shows, with no reload
  const [state, setState] = useOrgRemoteControl(orgId);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const switchRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const wasAsking = useRef(false);
  const arrived = useRef(false);
  const arrivedHoldEnds = useRef(0); // story 4595: when the arrival's hold runs out
  const arrivalRetake = useRef(false); // story 4595: the next run takes the arrival again (a cleanup inside the hold)

  // story #4583: every «원격 제어 켜러 가기» lands here (`/desktop#remote-control`) — once the card is drawn, bring it into view and put
  // the focus on the switch (an owner) or on the card (anyone else). It only moves; turning it on stays one press on the switch.
  // AC6 live: an in-app link press reaches here by a client navigation — Next's scroll handler may move the focus after this
  // effect, and the `#` may not be on the address yet; `takeArrival` and `holdArrivalFocus` (remote-off.tsx) cover both.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    // story 4595 (codex on 5021): a retake counts only inside the hold it came from, and no card (state null) ends it. It is read here,
    // before the state checks, so a flag left by a cleanup can never fire after the hold ran out (state → null → value).
    const retake = arrivalRetake.current && !!state && Date.now() < arrivedHoldEnds.current;
    arrivalRetake.current = false;
    if (!state) return;
    if (!retake) {
      if (arrived.current) return;
      const byHash = window.location.hash === `#${REMOTE_CONTROL_ANCHOR}`;
      if (!takeArrival() && !byHash) return;
    }
    arrived.current = true;
    cardRef.current?.scrollIntoView({ block: 'center' });
    const target = state.can_change ? switchRef.current : cardRef.current;
    if (!target) return;
    const release = holdArrivalFocus(target, cardRef.current);
    arrivedHoldEnds.current = Date.now() + ARRIVAL_HOLD_MS;
    return () => {
      release();
      // story 4595: a cleanup inside the hold (a development Strict re-run, or the value changing in those 1.5 s) leaves the next run a
      // retake — but only while the focus is still where the arrival put it (the switch, or the body after a re-draw). A person who
      // moved the focus away (Yuna on 5ecb3f9da) keeps it: the retake does not take it back.
      const active = document.activeElement;
      const stillArrival = active === null || active === document.body || active === target;
      if (Date.now() < arrivedHoldEnds.current && stillArrival) arrivalRetake.current = true;
    };
  }, [state]);

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
  // story #4583 (Yuna copy.md 5b): the owner named in «조직 소유자({owners})만 …» (no parenthesis when there is no name)
  const owners = formatOwners(state.owner_names ?? [], (first, n) => tOff('ownersMore', { first, n }));
  const ownerNames = { owners, hasOwners: owners ? 'yes' : 'no' };

  return (
    // the anchor (id · ref · focus · arrival mark) is the card's own wrapper: the ds Card takes no ref, and the arrival ring is drawn on the wrapper from the same mark
    <div ref={cardRef} id={REMOTE_CONTROL_ANCHOR} tabIndex={-1} className="scroll-mt-24 rounded-ds-control focus:outline-none data-[arrived]:ring-2 data-[arrived]:ring-ds-action" data-testid="desktop-remote-control">
    <Card className="break-keep flex flex-col gap-2 p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-ds-card-title font-semibold text-ds-ink">{t('title')}</h2>
        {state.can_change ? (
          // story 4890 (UI-7 · 겸사 셋): the ds Toggle (a ≥44 press on touch — before, an old 32×18 switch). Its words are the heading's: the toggle's own label is kept for the screen reader only (it names the switch), its on/off WORDS stay drawn.
          // The arrival ring (story #4583) is drawn on the switch from the same mark (`data-arrived`) — here through the wrapper.
          <span className="[&_[data-slot=ds-toggle-field]>span:not([data-slot])]:sr-only [&_[data-slot=ds-toggle][data-arrived]]:ring-2 [&_[data-slot=ds-toggle][data-arrived]]:ring-ds-action">
            <Toggle
              ref={switchRef}
              label={t('title')}
              onText={t('stateOn')}
              offText={t('stateOff')}
              checked={state.enabled}
              disabled={busy || asking}
              onCheckedChange={(on) => { if (on) void change(true); else { setFailed(false); setAsking(true); } }}
            />
          </span>
        ) : null}
      </div>
      <p className="text-ds-body text-ds-ink-3">{t('body')}</p>
      {/* story #4583 (Yuna copy.md 5a): what off means, for everyone */}
      {!state.enabled ? <p className="text-ds-body text-ds-ink-3" data-testid="desktop-remote-control-off-effect">{t('offEffect')}</p> : null}
      <p className="text-ds-small text-ds-ink-3">{t('allowed')}</p>
      {state.enabled && state.enabled_at ? <EnabledSince at={state.enabled_at} /> : null}
      {!state.can_change ? (
        <p className="text-ds-small text-ds-ink-3" data-testid="desktop-remote-control-owner-only">
          {state.enabled ? t('ownerOnlyOn', ownerNames) : t('ownerOnlyOff', ownerNames)}
        </p>
      ) : null}
      {asking ? <ConfirmOff busy={busy} onConfirm={() => void change(false)} onCancel={() => setAsking(false)} /> : null}
      <p className="text-ds-small text-ds-failed" role="status">{failed ? t('failed') : ''}</p>
    </Card>
    </div>
  );
}

function EnabledSince({ at }: { at: string }) {
  // the same date form as «연결된 기기» right below (deviceDateOptions — no year within this year · Yuna 12:53Z)
  const t = useTranslations('desktop.remoteControl');
  const format = useFormatter();
  const tz = useViewerTimeZone() ?? 'UTC';
  const date = format.dateTime(new Date(at), { ...deviceDateOptions(at, new Date(), tz), timeZone: tz });
  return <p className="text-ds-small text-ds-ink-3">{t('since', { date })}</p>;
}

function ConfirmOff({ busy, onConfirm, onCancel }: { busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  const t = useTranslations('desktop.remoteControl');
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { cancelRef.current?.focus(); }, []); // [취소] first (Yuna B-1 ①)
  return (
    <div className="flex flex-col gap-2 border-t border-ds-line pt-3" role="group" aria-label={t('confirmOff')}>
      <p className="text-ds-body text-ds-ink">{t('confirmOff')}</p>
      <div className="flex gap-2">
        <Button variant="danger" disabled={busy} onClick={onConfirm}>{t('turnOff')}</Button>
        <Button variant="secondary" ref={cancelRef} disabled={busy} onClick={onCancel}>{t('cancel')}</Button>
      </div>
    </div>
  );
}
