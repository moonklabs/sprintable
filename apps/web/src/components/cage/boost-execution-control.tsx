'use client';

import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { fetchWithAuth } from '@/lib/db/client';
import { formatMinorCurrency, type GenerationBudgetCurrency } from '@/components/content/generation-budget-indicator';
import { adsBoostObjectiveLabel } from '@/lib/ads-boost-objective-label';
import { formatScheduledAt } from '@/components/content/schedule-format';
import { formatViewerRelativeTime } from '@/lib/storage/format';
import { pickEuroJosa, pickIRaJosa } from '@/lib/korean-particle';
import { useViewerTimeZone } from '@/components/viewer-time-zone';
import { useConnectRulesHref } from '@/app/dashboard/dashboard-shell';
import {
  BOOST_RUN_STATUSES, COMMAND_FAILURE_KINDS, COMMAND_STATUSES,
} from '@/lib/ads-boost-states.generated';
import { useTeamTimeZone } from '@/components/team-time-zone';

// story #3806(Phase3·3-2 PR5, 유나 §절 §2 「중지 스위치」) — 실행 중인 홍보의 중지/재개.
// 자리 = 상세(이 컴포넌트, gates/[id]/page.tsx에서 마운트)·성과 보드 행(조각⑥, 같은
// 컴포넌트 재사용 예정).
//
// 「홍보 시작」 트리거 — 페드루 PO 콜①(2026-09-11 11:47Z, 그라운딩 회신): 카드 AC2가
// 「[제품] 상한 내 실행」이라 원래 설계는 승인 뒤 봉인 starts_at에 BE 스케줄러가
// 자동 실행하는 것이지만, PR3에 그 자동발화가 0건(grep 확認)이라 «승인만 하고 아무것도
// 안 도는» 화면을 첫 출시에 낼 수 없어 사람 클릭을 **지름길**로 이번 PR에 얹는다 —
// 목표(자동 실행)는 후속 조각(BE 스케줄러) 몫으로 남는다. starts_at 이전엔 버튼을
// 비활성 + 사유 문구로(서버가 그 축을 검사하지 않아 클라에서 막는다, 그라운딩 확認).
//
// run_status 원천은 /spend(조각⑤ 착수 前 자체발견 fix로 신설) — 새 GET 신설 안 함.

// story #4461 — a pause stopped on the connection the campaign lives in (gone · token dead): it did not and will not reach the
// campaign. One rule for the honest block and for ending the «중지 중…» wait.
function pauseStoppedOnConnection(pc: { status: string; failure_kind: string | null; error_code: string | null } | null | undefined): boolean {
  if (!pc) return false;
  return (pc.status === 'blocked_unapproved' && pc.error_code === 'ADS_BOOST_CONNECTION_UNAVAILABLE')
    || (pc.status === 'blocked' && pc.failure_kind === 'connection');
}

export interface BoostExecutionControlProps {
  orgId: string;
  gateId: string;
  sealedAdsBudgetMinor: number | null;
  sealedAdsCurrency: string | null;
  sealedAdsStartsAt: string | null;
  sealedAdsEndsAt: string | null;
  sealedAdsObjective: string | null;
  // story #4466 — the gate's status: a boost whose gate is back in review is paused by the server and cannot be resumed there
  gateStatus?: string | null;
  // story #3806(Phase3·3-2 PR 12, 페드루 PO 실측 캡처 2026-09-11 18:16Z) — 「눌렀는데
  // 아무 일도 없었다」 결함 처방. 「광고비 다시 수집」 성공은 이 컴포넌트 밖(형제
  // GateActivityHistory)에 새 이력 행을 남기는데 그쪽이 스스로 재조회할 방법이
  // 없었다 — 부모(gates/[id]/page.tsx)가 이 콜백으로 그 형제의 refreshKey를 올린다.
  onSpendRefreshed?: () => void;
}

// story #4447 — the run statuses are the server's contract (generated from backend/app/services/ads_boost_states.py): the web
// once had `failed` (never written) and lacked `pause_pending` (a delayed pause). A value outside the set renders as unknown.
const isOneOf = (list: readonly string[], v: string | null | undefined): boolean => v != null && list.includes(v);
// story #3806 PR 9②(PR8 #4185, 페드루 PO 確定 2026-09-11) — boost_start 커맨드의
// initiated_by. /spend(SpendSummaryResponse)에 실린다 — POST /start 응답
// (CommandResponse)에도 있지만 scheduler 기동분은 이 화면이 그 POST를 절대 안
// 거치므로(PR6 워커가 직접 실행) /spend가 유일한 관측 축(PR8 diff 확認).
type InitiatedBy = 'scheduler' | 'human';
// story #4409 — the start command's own state (/spend `start_command`). A start stopped for a person to check
// (dead_letter + needs_check) used to be invisible: the run stays «pending», so the screen offered «start» again, which only
// returned the same stopped command.
interface StartCommand {
  id: string;
  status: string;
  failure_kind: string | null;
  error_code: string | null;
  // the campaign to look for in the ad account — only for «outcome unknown» (BE boost_campaign_name)
  campaign_name?: string | null;
  // story #4447 — the server's own «this person may retry it» (human_retryable · people only); the retry button reads only this
  retryable?: boolean;
}
// Meta may have created the campaign: retried only after the person confirms it does not exist in the ad account.
const OUTCOME_UNKNOWN = 'ADS_BOOST_CREATE_OUTCOME_UNKNOWN';
// story #4417 — the ad account's currency is not the approved one: nothing was created (the next step is a new request)
const ACCOUNT_CURRENCY_MISMATCH = 'ADS_BOOST_ACCOUNT_CURRENCY_MISMATCH';
// story #4458 — a campaign made on another budget (a re-seal during its create): not switched on, a person decides
const CREATED_BUDGET_DIFFERS = 'ADS_BOOST_CREATED_BUDGET_DIFFERS';
// story #4417 (Yuna 5883612567) — only these codes mean «the spend came in another currency»; every other reason the server
// stopped the boost (e.g. repeated read failures, or a code added later) gets the line without a reason — never a wrong one.
const SPEND_CURRENCY_CODES: ReadonlySet<string> = new Set(['META_ADS_SPEND_CURRENCY_MISMATCH', 'META_ADS_SPEND_UNKNOWN_CURRENCY']);
// story #4417 (Qadir 01a0eb71 A) — the ad connection is gone: nothing we can read or pause; the person stops it in Ads Manager
const SPEND_CONTEXT_LOST = 'ADS_SPEND_CONTEXT_LOST';
export function isSpendCurrencyCode(code: string): boolean {
  return SPEND_CURRENCY_CODES.has(code);
}

interface SpendData {
  // a string: a value outside the contract must still arrive (and render as unknown), never be assumed to be one of ours
  run_status: string | null;
  initiated_by?: InitiatedBy | null;
  start_command?: StartCommand | null;
  // story #4416 — the run's campaign for «stop in Ads Manager» and the ad channel (null without a run)
  campaign_id?: string | null;
  ad_account_id?: string | null;
  campaign_name?: string | null;
  ad_channel?: string | null;
  // story #4417 — why the server blocked the spend check (the run is paused · no resume) · the ad account's currency read before
  // the start
  spend_blocked_code?: string | null;
  account_currency?: string | null;
  // story #4458 — a campaign held because it was created on another budget: the budget it was created with
  created_budget_minor?: number | null;
  // story #4461 — the latest pause (a stopped one on the connection is told honestly)
  pause_command?: { status: string; failure_kind: string | null; error_code: string | null } | null;
  // story #4460 — a cancel asked for and not finished · the cycles that ended before this one · the gate's status (voided =
  // cancelled) · whether this viewer may cancel (the requester or an owner/admin — the server's own rule)
  cancel_requested?: boolean;
  previous_cycles?: PreviousCycle[];
  gate_status?: string | null;
  can_cancel?: boolean;
}

interface PreviousCycle {
  campaign_id: string | null;
  spend_minor: number | null;
  currency: string | null;
  started_at: string | null;
  ended_at: string;
  end_reason: string;
}

// story #4416 — start · retry · pause · resume are queued commands the worker runs later (every minute, transient failures
// retried 2 → 4 → 8 → 16 min), so the card reads /spend until the state it waits for lands (PO A, 2026-09-29 01:01Z): 5 s for
// the first 3 min, then 30 s, up to 35 min for a start; pause and resume wait 3 min for run_status. The cap is wall-clock
// from the start of the wait; the tab being hidden stops the timer and a return reads once.
type WaitOp = 'start' | 'pause' | 'resume' | 'cancel';
const POLL_FAST_MS = 5_000;
const POLL_SLOW_MS = 30_000;
const POLL_FAST_WINDOW_MS = 3 * 60_000;
const POLL_CAP_MS: Record<WaitOp, number> = { start: 35 * 60_000, pause: 3 * 60_000, resume: 3 * 60_000, cancel: 3 * 60_000 };
const ACTIVE_COMMAND_STATUSES = new Set(['pending', 'in_progress']);

function waitSettled(op: WaitOp, d: SpendData): boolean {
  const run = d.run_status ?? null;
  // story #4447 — a value outside the contract ends any wait (the card shows it as unknown; polling it would never settle)
  if (run !== null && !isOneOf(BOOST_RUN_STATUSES, run)) return true;
  if (op === 'cancel') return !d.cancel_requested; // story #4460 — the cancel finished (the campaign known to be off)
  if (op === 'pause') return run === 'paused';
  if (op === 'resume') return run === 'running';
  if (run === 'running' || run === 'paused' || run === 'pause_pending') return true;
  // completed · failed · dead_letter · voided · blocked (or no command at all) — nothing left to wait for
  return !d.start_command || !ACTIVE_COMMAND_STATUSES.has(d.start_command.status);
}

const ADS_MANAGER_CAMPAIGNS_URL = 'https://adsmanager.facebook.com/adsmanager/manage/campaigns';

/** The Ads Manager page that opens the campaign (account + campaign), else the account, else its first screen. */
export function adsManagerCampaignUrl(adAccountId: string | null | undefined, campaignId: string | null | undefined): string {
  if (!adAccountId) return ADS_MANAGER_CAMPAIGNS_URL;
  const query = new URLSearchParams({ act: adAccountId });
  if (campaignId) query.set('selected_campaign_ids', campaignId);
  return `${ADS_MANAGER_CAMPAIGNS_URL}?${query.toString()}`;
}

export function BoostExecutionControl({
  orgId, gateId, sealedAdsBudgetMinor, sealedAdsCurrency, sealedAdsStartsAt, sealedAdsEndsAt, sealedAdsObjective, gateStatus,
  onSpendRefreshed,
}: BoostExecutionControlProps) {
  const teamTz = useTeamTimeZone(); // story #4443 PR3b — a promised time is the team's (the org's zone)
  const t = useTranslations('cage');
  const tContent = useTranslations('content');
  const locale = useLocale();
  const displayTimezone = useViewerTimeZone(); // story #4443 PR2b — the viewer's zone (null until known)
  const [runStatus, setRunStatus] = useState<string | null>(null);
  const connectRulesHref = useConnectRulesHref('/organization/channels');
  const [initiatedBy, setInitiatedBy] = useState<InitiatedBy | null>(null);
  const [startCommand, setStartCommand] = useState<StartCommand | null>(null);
  // story #4417 — the spend could not be checked against the budget (the server paused the boost and refuses resume) · the
  // ad account's currency read before the start (the Ads Manager link uses 4416's run ids)
  const [spendBlockedCode, setSpendBlockedCode] = useState<string | null>(null);
  const [accountCurrency, setAccountCurrency] = useState<string | null>(null);
  const [createdBudget, setCreatedBudget] = useState<number | null>(null);
  const [pauseCommand, setPauseCommand] = useState<SpendData['pause_command']>(null);
  // story #4460 — «홍보 취소»
  const [cancelRequested, setCancelRequested] = useState(false);
  const [previousCycles, setPreviousCycles] = useState<PreviousCycle[]>([]);
  const [spendGateStatus, setSpendGateStatus] = useState<string | null>(null);
  const [canCancel, setCanCancel] = useState(false);
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);
  const [needsCheckOpen, setNeedsCheckOpen] = useState(false);
  const [needsCheckConfirmed, setNeedsCheckConfirmed] = useState(false);
  // story #4412 — «it is already in my ad account»: the lookup's answer when it did not adopt
  const [adoptOutcome, setAdoptOutcome] = useState<
    | { result: 'not_found' }
    // another boost already holds that campaign (the server's unique ids, 0420) — nothing linked
    | { result: 'already_linked' }
    | { result: 'ambiguous'; candidates: { id: string | null; name: string | null; created_time: string | null }[] }
    // the found ad set's budget is not the approved amount (PO 00:48Z) — nothing linked
    | { result: 'budget_mismatch'; adsetBudgetMinor: number | null; sealedBudgetMinor: number | null }
    | null
  >(null);
  const [adopting, setAdopting] = useState(false);
  const [adoptOpen, setAdoptOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [startConfirmOpen, setStartConfirmOpen] = useState(false);
  const [pauseConfirmOpen, setPauseConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // story #3806(Phase3·3-2 PR 12, 페드루 PO 確定 2026-09-11 17:26Z) — 「광고비
  // 다시 수집」 버튼 전용 상태(start/pause/resume의 submitting/actionError와 분리
  // — 서로 다른 요청이 같은 로딩/에러 표시를 공유하면 사용자가 어느 버튼이 도는지
  // 헷갈린다).
  const [refreshingSpend, setRefreshingSpend] = useState(false);
  const [spendRefreshError, setSpendRefreshError] = useState<string | null>(null);
  // story #3806(Phase3·3-2 PR 12, 페드루 PO 실측 캡처 2026-09-11 18:16Z) — 「클릭
  // 前/後 화면이 바이트 동일」 결함 처방. POST 응답값을 그대로 실어 즉시 렌더(재조회
  // 왕복 0 — 이미 응답에 다 있다).
  const [lastRefresh, setLastRefresh] = useState<{ spendMinor: number; capturedAt: string } | null>(null);
  // story #4416 — what the card is waiting for (the waiting line) and the notice left when the cap passed first
  const [waiting, setWaiting] = useState<WaitOp | null>(null);
  const [capNotice, setCapNotice] = useState<WaitOp | null>(null);
  const [runAd, setRunAd] = useState<Pick<SpendData, 'campaign_id' | 'ad_account_id' | 'campaign_name' | 'ad_channel'>>({});
  const waitRef = useRef<{ op: WaitOp; startedAt: number } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef(false);
  const unmountedRef = useRef(false);

  const clearTimer = () => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
  };

  const beginWait = (op: WaitOp) => {
    clearTimer();
    waitRef.current = { op, startedAt: Date.now() };
    setWaiting(op);
  };

  const endWait = (cappedOp: WaitOp | null) => {
    clearTimer();
    waitRef.current = null;
    setWaiting(null);
    setCapNotice(cappedOp === 'cancel' ? 'pause' : cappedOp); // story #4460 — a cancel waits for its pause: the same notice
  };

  // The one place that decides the next read — after a response or a failed read alike — so the cap (wall-clock
  // from the start of the wait) always ends it: a /spend that keeps failing leaves the notice instead of polling on.
  const scheduleNext = () => {
    clearTimer();
    const wait = waitRef.current;
    if (!wait || unmountedRef.current) return;
    if (Date.now() - wait.startedAt >= POLL_CAP_MS[wait.op]) { endWait(wait.op); return; }
    if (document.hidden) return;
    const slow = Date.now() - wait.startedAt >= POLL_FAST_WINDOW_MS;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (inFlightRef.current) { scheduleNext(); return; } // the previous read has not come back: skip this tick
      void load(false);
    }, slow ? POLL_SLOW_MS : POLL_FAST_MS);
  };

  // After each /spend response: a start command still queued starts the wait on its own (mount · after «link existing
  // campaign» · after a retry), the wait ends when its state lands, and the cap leaves a notice instead of polling on.
  const afterSpend = (d: SpendData, mayBeginStartWait: boolean) => {
    if (unmountedRef.current) return;
    const pauseStopped = pauseStoppedOnConnection(d.pause_command);
    if (!waitRef.current && mayBeginStartWait && !waitSettled('start', d)) beginWait('start');
    // story #4447 — a pause already requested (a reload while it has not landed): wait for it with the 4416 cap like after a click
    if (!waitRef.current && mayBeginStartWait && d.run_status === 'pause_pending') beginWait('pause');
    // story #4460 — a cancel not finished yet (a reload while it waits for the pause): wait for it within the pause's cap
    if (!waitRef.current && mayBeginStartWait && d.cancel_requested) beginWait('cancel');
    const wait = waitRef.current;
    if (!wait) return;
    // story #4461 (PO 14:05Z) — a pause that could not reach the campaign's account will not land: «중지 중…» would be false comfort
    // next to the honest block — the wait ends there, with no cap notice (the block says what to do)
    if (waitSettled(wait.op, d) || (wait.op === 'pause' && pauseStopped)) { endWait(null); return; }
    scheduleNext();
  };

  const load = async (mayBeginStartWait = true) => {
    inFlightRef.current = true;
    try {
      const r = await fetchWithAuth(`/api/organizations/${orgId}/ads-boosts/${gateId}/spend`);
      if (!r.ok) throw new Error(`status ${r.status}`);
      const json = (await r.json()) as { data?: SpendData };
      const d: SpendData = json.data ?? { run_status: null };
      if (unmountedRef.current) return;
      setRunStatus(d.run_status ?? null);
      setStartCommand(d.start_command ?? null);
      // story #3806 PR 9② — PR8(#4185) 착지 前엔 이 필드가 응답에 없어 항상
      // undefined→null로 떨어진다(falsy-safe, 아래 렌더가 자동으로 숨는다).
      setInitiatedBy(d.initiated_by ?? null);
      setSpendBlockedCode(d.spend_blocked_code ?? null);
      setAccountCurrency(d.account_currency ?? null);
      setCreatedBudget(d.created_budget_minor ?? null);
      setPauseCommand(d.pause_command ?? null);
      setCancelRequested(Boolean(d.cancel_requested));
      setPreviousCycles(Array.isArray(d.previous_cycles) ? d.previous_cycles : []);
      setSpendGateStatus(d.gate_status ?? null);
      setCanCancel(Boolean(d.can_cancel));
      setRunAd({
        campaign_id: d.campaign_id ?? null, ad_account_id: d.ad_account_id ?? null,
        campaign_name: d.campaign_name ?? null, ad_channel: d.ad_channel ?? null,
      });
      setCapNotice(null); // a cap notice lasts until the next /spend response
      setLoaded(true);
      afterSpend(d, mayBeginStartWait);
    } catch {
      if (unmountedRef.current) return;
      setLoaded(true);
      if (waitRef.current) scheduleNext(); // a failed read does not end the wait; the cap in scheduleNext still does
    } finally {
      inFlightRef.current = false;
    }
  };

  useEffect(() => {
    unmountedRef.current = false;
    void load();
    const onVisibility = () => {
      if (document.hidden) { clearTimer(); return; }
      if (waitRef.current && !inFlightRef.current) void load(false); // back in view: read once, then go on within the cap
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      unmountedRef.current = true;
      clearTimer();
      waitRef.current = null;
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, gateId]);

  const doAction = async (operation: 'start' | 'pause' | 'resume', onDone: () => void) => {
    setSubmitting(true);
    setActionError(null);
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgId}/ads-boosts/${gateId}/${operation}`, { method: 'POST' });
      if (!res.ok) {
        setActionError(t('boostExecutionActionError'));
        return;
      }
      onDone();
      beginWait(operation);
      void load();
    } catch {
      setActionError(t('boostExecutionActionError'));
    } finally {
      setSubmitting(false);
    }
  };

  // story #4460 — «홍보 취소»: the server voids the gate now and pauses a live campaign; the card then reads /spend until the cancel
  // finished (or the pause's cap). A refusal shows the server's own words (403 · already cancelled).
  const doCancel = async () => {
    setSubmitting(true);
    setActionError(null);
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgId}/ads-boosts/${gateId}/cancel`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setActionError(body?.error?.message || t('boostExecutionActionError'));
        return;
      }
      setCancelConfirmOpen(false);
      beginWait('cancel');
      void load();
    } catch {
      setActionError(t('boostExecutionActionError'));
    } finally {
      setSubmitting(false);
    }
  };

  const doRefreshSpend = async () => {
    setRefreshingSpend(true);
    setSpendRefreshError(null);
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgId}/ads-boosts/${gateId}/spend/refresh`, { method: 'POST' });
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('Retry-After'));
        // comments-refresh-button.tsx(story #3517)와 동형 방어 — 초를 못 읽으면
        // "0초 뒤"처럼 지어낸 숫자를 보이지 않고 "잠시 뒤"로 물러난다.
        setSpendRefreshError(
          Number.isFinite(retryAfter) && retryAfter > 0
            ? t('boostExecutionSpendRefreshRateLimited', { seconds: retryAfter })
            : t('boostExecutionSpendRefreshRateLimitedUnknown'),
        );
        return;
      }
      if (!res.ok) {
        setSpendRefreshError(t('boostExecutionActionError'));
        return;
      }
      const json = (await res.json()) as { data?: { spend_minor: number; captured_at: string } };
      if (json.data) {
        setLastRefresh({ spendMinor: json.data.spend_minor, capturedAt: json.data.captured_at });
      }
      void load();
      onSpendRefreshed?.();
    } catch {
      setSpendRefreshError(t('boostExecutionActionError'));
    } finally {
      setRefreshingSpend(false);
    }
  };

  const doRetryStart = async () => {
    if (!startCommand) return;
    setSubmitting(true);
    setActionError(null);
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgId}/publication-commands/${startCommand.id}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmed_no_campaign: startCommand.error_code === OUTCOME_UNKNOWN }),
      });
      if (!res.ok) {
        setActionError(t('boostExecutionActionError'));
        return;
      }
      setNeedsCheckOpen(false);
      setNeedsCheckConfirmed(false);
      beginWait('start');
      void load();
    } catch {
      setActionError(t('boostExecutionActionError'));
    } finally {
      setSubmitting(false);
    }
  };

  const doAdoptExisting = async () => {
    setAdopting(true);
    setActionError(null);
    setAdoptOutcome(null);
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgId}/ads-boosts/${gateId}/adopt-existing`, { method: 'POST' });
      if (!res.ok) {
        setActionError(t('boostExecutionActionError'));
        return;
      }
      const json = (await res.json()) as {
        data?: {
          result: string;
          candidates?: { id: string | null; name: string | null; created_time: string | null }[];
          adset_budget_minor?: number | null;
          sealed_budget_minor?: number | null;
        };
      };
      setAdoptOpen(false); // every answer closes the confirmation; the result line (if any) stays in the card
      if (json.data?.result === 'adopted') {
        void load(); // the start command is queued again: the wait begins from its state
      } else if (json.data?.result === 'already_linked') {
        setAdoptOutcome({ result: 'already_linked' });
      } else if (json.data?.result === 'budget_mismatch') {
        setAdoptOutcome({
          result: 'budget_mismatch',
          adsetBudgetMinor: json.data.adset_budget_minor ?? null, sealedBudgetMinor: json.data.sealed_budget_minor ?? null,
        });
      } else if (json.data?.result === 'ambiguous') {
        setAdoptOutcome({ result: 'ambiguous', candidates: json.data.candidates ?? [] });
      } else {
        setAdoptOutcome({ result: 'not_found' });
      }
    } catch {
      setActionError(t('boostExecutionActionError'));
    } finally {
      setAdopting(false);
    }
  };

  if (!loaded) return null;

  // the approved conditions (budget · schedule · objective) — the start confirmation and the «link existing campaign»
  // confirmation show the same lines (Yuna 00:49Z)
  const sealedFacts = (
    <div className="space-y-1 rounded-lg bg-muted/40 px-2.5 py-1.5 text-[11.5px]">
      <p>
        <span className="text-muted-foreground">{t('adsBoostBudgetLabel')} · </span>
        <span className="text-foreground font-medium">
          {sealedAdsBudgetMinor !== null && sealedAdsCurrency
            ? formatMinorCurrency(sealedAdsBudgetMinor, sealedAdsCurrency as GenerationBudgetCurrency, locale, tContent)
            : null}
        </span>
      </p>
      {sealedAdsStartsAt && sealedAdsEndsAt ? (
        <p>
          <span className="text-muted-foreground">{t('adsBoostScheduleLabel')} · </span>
          <span className="text-foreground">
            {formatScheduledAt(sealedAdsStartsAt, teamTz, displayTimezone).display}
            {' ~ '}
            {formatScheduledAt(sealedAdsEndsAt, teamTz, displayTimezone).display}
          </span>
        </p>
      ) : null}
      {sealedAdsObjective ? (
        <p>
          <span className="text-muted-foreground">{t('adsBoostObjectiveLabel')} · </span>
          <span className="text-foreground">{adsBoostObjectiveLabel(sealedAdsObjective, tContent)}</span>
        </p>
      ) : null}
    </div>
  );

  // story #4416 — the line while waiting (the button words, or «trying again» while the start retries on its own)
  const startRetrying = startCommand !== null && startCommand.failure_kind === 'transient'
    && ACTIVE_COMMAND_STATUSES.has(startCommand.status);
  const waitingLine = waiting && waiting !== 'cancel' ? (
    <p className="text-xs text-muted-foreground" data-testid="boost-execution-waiting" role="status">
      {waiting === 'start'
        ? (startRetrying ? t('boostExecutionStartRetrying') : t('boostExecutionStarting'))
        : waiting === 'pause' ? t('boostExecutionPausing') : t('boostExecutionResuming')}
    </p>
  ) : null;
  // After the cap: start and resume only ask for a refresh; a pause that has not landed may still be spending, so it says so
  // and, for Meta ads, names the campaign and links to stopping it in Ads Manager. The sandbox never spends (refresh only);
  // an unknown channel keeps the money line (no name or link — the address is unknown).
  const capNoticeBlock = capNotice === 'start' ? (
    <p className="text-xs text-muted-foreground break-keep" data-testid="boost-execution-cap-notice">{t('boostExecutionStartCapNotice')}</p>
  ) : capNotice === 'resume' ? (
    <p className="text-xs text-muted-foreground break-keep" data-testid="boost-execution-cap-notice">{t('boostExecutionResumeCapNotice')}</p>
  ) : capNotice === 'pause' ? (
    runAd.ad_channel === 'ads_sandbox' ? (
      <p className="text-xs text-muted-foreground break-keep" data-testid="boost-execution-cap-notice">{t('boostExecutionPauseCapSandbox')}</p>
    ) : (
      <div className="space-y-1 text-xs break-keep" data-testid="boost-execution-cap-notice">
        <p className="text-foreground">{t('boostExecutionPauseCapSpend')}</p>
        {runAd.ad_channel === 'meta_ads' && runAd.campaign_name ? (
          <p className="text-muted-foreground" data-testid="boost-execution-cap-campaign">
            {t('boostNeedsCheckCampaignToFind', { campaignName: runAd.campaign_name })}
          </p>
        ) : null}
        {runAd.ad_channel === 'meta_ads' ? (
          <a
            href={adsManagerCampaignUrl(runAd.ad_account_id, runAd.campaign_id)}
            target="_blank" rel="noopener noreferrer"
            className="text-primary hover:underline" data-testid="boost-execution-ads-manager-link"
          >
            {t('boostExecutionStopInAdsManager')}<span aria-hidden="true"> ↗</span>
          </a>
        ) : null}
      </div>
    )
  ) : null;

  // story #4447 — the state table, on the server's closed value sets. A voided start (its approval was replaced) is no start;
  // anything outside the sets is the safe cell — never «홍보 시작».
  const command = startCommand && startCommand.status !== 'voided' ? startCommand : null;
  const runKnown = runStatus === null || isOneOf(BOOST_RUN_STATUSES, runStatus);
  const commandKnown = !command
    || (isOneOf(COMMAND_STATUSES, command.status) && (command.failure_kind === null || isOneOf(COMMAND_FAILURE_KINDS, command.failure_kind)));
  if (!runKnown || !commandKnown) {
    return (
      <div className="space-y-2 break-keep" data-testid="boost-execution-control">
        <p className="text-xs text-muted-foreground" data-testid="boost-state-unknown" role="status">{t('boostStateUnknown')}</p>
      </div>
    );
  }
  const runActive = runStatus === 'running' || runStatus === 'paused' || runStatus === 'pause_pending';
  // story #4460 — /spend says the gate's status too (a cancel voids it while the page still holds the older gate)
  const effectiveGateStatus = spendGateStatus ?? gateStatus ?? null;
  const offApproved = effectiveGateStatus != null && effectiveGateStatus !== 'approved'; // story #4466

  // story #4460 (Yuna 16:46Z) — the cycles that ended before this one: «지난 홍보 · {기간} · 쓴 광고비 {amount}»
  const previousCyclesBlock = previousCycles.length ? (
    <ul className="space-y-1 text-xs text-muted-foreground" data-testid="boost-previous-cycles">
      {previousCycles.map((c) => (
        <li key={`${c.ended_at}-${c.campaign_id ?? ''}`} data-testid="boost-previous-cycle">
          {t('boostPreviousCycle', {
            period: `${c.started_at ? formatViewerScheduledAt(c.started_at, displayTimezone).display : ''} ~ ${formatViewerScheduledAt(c.ended_at, displayTimezone).display}`,
            amount: c.spend_minor !== null && c.currency
              ? formatMinorCurrency(c.spend_minor, c.currency as GenerationBudgetCurrency, locale, tContent) : '—',
          })}
        </li>
      ))}
    </ul>
  ) : null;

  // story #4460 — «홍보 취소» (only for whom the server says may: the requester or an owner/admin) and its confirmation
  const cancelControls = canCancel && !cancelRequested && !offApproved ? (
    <>
      <Button variant="outline" size="sm" disabled={submitting} onClick={() => setCancelConfirmOpen(true)} data-testid="boost-cancel-trigger">
        {t('boostCancel')}
      </Button>
      <Dialog open={cancelConfirmOpen} onOpenChange={setCancelConfirmOpen}>
        <DialogContent data-testid="boost-cancel-confirm-dialog">
          <DialogHeader>
            <DialogTitle>{t('boostCancelConfirmTitle')}</DialogTitle>
            <DialogDescription>{t('boostCancelConfirmBody')}</DialogDescription>
          </DialogHeader>
          {/* Yuna 16:46Z — the one way money can go out again: a paused Meta ad turned back on in Ads Manager */}
          {runAd.ad_channel === 'meta_ads' ? (
            <p className="text-sm text-muted-foreground" data-testid="boost-cancel-confirm-meta">{t('boostCancelConfirmMetaNote')}</p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" autoFocus onClick={() => setCancelConfirmOpen(false)} disabled={submitting}>
              {t('boostCancelClose')}
            </Button>
            <Button variant="destructive" onClick={() => void doCancel()} disabled={submitting} data-testid="boost-cancel-confirm">
              {t('boostCancel')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  ) : null;

  // story #4460 — cancelled: the gate is voided and the run cleared (the cycle kept). No action here; a new request starts again.
  // A gate voided another way while its campaign is still there (paused) is not «취소됨»: it keeps 4466's approval-gone line.
  if (effectiveGateStatus === 'voided' && !cancelRequested && !runActive) {
    return (
      <div className="space-y-2 break-keep" data-testid="boost-execution-control">
        <p className="text-xs text-muted-foreground" data-testid="boost-cancelled">{t('boostCancelled')}</p>
        {previousCyclesBlock}
      </div>
    );
  }
  // story #4460 — «취소 중»: the campaign is not known to be off yet. The 4461 block stays (a pause stopped on the connection —
  // money may still go out); nothing else to press.
  if (cancelRequested) {
    return (
      <div className="space-y-2 break-keep" data-testid="boost-execution-control">
        <p className="text-xs text-muted-foreground" data-testid="boost-cancelling" role="status">{t('boostCancelInProgress')}</p>
        {pauseStoppedOnConnection(pauseCommand) ? (
          <p className="text-xs text-foreground" data-testid="boost-pause-connection-lost">{t('boostPauseConnectionLost')}</p>
        ) : null}
        {capNoticeBlock}
        {previousCyclesBlock}
      </div>
    );
  }

  const needsCheck = command?.status === 'dead_letter' && command.failure_kind === 'needs_check';
  if (needsCheck && !runActive) {
    const outcomeUnknown = command.error_code === OUTCOME_UNKNOWN;
    const currencyMismatch = command.error_code === ACCOUNT_CURRENCY_MISMATCH;
    const budgetDiffers = command.error_code === CREATED_BUDGET_DIFFERS;
    return (
      <div className="space-y-2 break-keep" data-testid="boost-execution-control">
        <p className="text-xs">
          <span className="font-medium text-foreground" data-testid="boost-needs-check">{t('boostNeedsCheckTitle')}</span>
        </p>
        <p className="text-xs text-muted-foreground" data-testid="boost-needs-check-reason">
          {budgetDiffers ? (() => {
            // PO 10:56Z — the facts only: re-seals only lower the budget, so «request again at that budget» never works (no link)
            const money = (minor: number | null) => (minor !== null && sealedAdsCurrency
              ? formatMinorCurrency(minor, sealedAdsCurrency as GenerationBudgetCurrency, locale, tContent) : '');
            // Yuna 11:00Z — the approved budget is the «총예산» line right above: not repeated here
            return t('boostNeedsCheckCreatedBudgetDiffers', { amount: money(createdBudget) });
          })() : currencyMismatch
            ? (accountCurrency && sealedAdsCurrency
              ? t('boostAccountCurrencyMismatch', { accountCurrency, approvedCurrency: sealedAdsCurrency })
              : t('boostAccountCurrencyMismatchNoCodes'))
            : outcomeUnknown ? t('boostNeedsCheckOutcomeUnknown') : t('boostNeedsCheckStopped')}
        </p>
        {actionError ? <p className="text-xs text-destructive" data-testid="boost-execution-error">{actionError}</p> : null}
        {/* story #4417 — a different account currency: retry and link are hidden (the sealed values give the same answer
            every time; the next step is a new request with a matching account — Yuna) */}
        {/* story #4458 — a campaign made on another budget: no retry either (it stops the same way every time) */}
        {currencyMismatch || budgetDiffers ? null : (
        <div className="flex flex-wrap gap-2">
          {outcomeUnknown ? (
            // story #4412 — link the campaign this start may have made (Yuna 00:49Z: link first, then retry, both outline)
            <Button
              variant="outline" size="sm" disabled={adopting}
              onClick={() => { setAdoptOutcome(null); setAdoptOpen(true); }} data-testid="boost-adopt-trigger"
            >
              {t('boostAdoptTitle')}
            </Button>
          ) : null}
          <Button variant="outline" size="sm" onClick={() => setNeedsCheckOpen(true)} data-testid="boost-needs-check-retry-trigger">
            {t('boostNeedsCheckRetry')}
          </Button>
        </div>
        )}
        {/* the lookup's answer stays in the card (not a toast); success needs no line — the card turns «running» */}
        {adoptOutcome?.result === 'not_found' ? (
          <p className="text-xs text-muted-foreground" data-testid="boost-adopt-not-found">{t('boostAdoptNotFound')}</p>
        ) : null}
        {adoptOutcome?.result === 'already_linked' ? (
          <p className="text-xs text-muted-foreground" data-testid="boost-adopt-already-linked">{t('boostAdoptAlreadyLinked')}</p>
        ) : null}
        {adoptOutcome?.result === 'budget_mismatch' ? (() => {
          const approved = adoptOutcome.sealedBudgetMinor !== null && sealedAdsCurrency
            ? formatMinorCurrency(adoptOutcome.sealedBudgetMinor, sealedAdsCurrency as GenerationBudgetCurrency, locale, tContent)
            : '—';
          const found = adoptOutcome.adsetBudgetMinor !== null && sealedAdsCurrency
            ? formatMinorCurrency(adoptOutcome.adsetBudgetMinor, sealedAdsCurrency as GenerationBudgetCurrency, locale, tContent)
            : '—';
          return (
            <p className="text-xs text-muted-foreground" data-testid="boost-adopt-budget-mismatch">
              {/* the particles follow the amount's last syllable (ko): «…원이라» · «…원으로» */}
              {t('boostAdoptBudgetMismatch', {
                approved, found,
                foundRa: pickIRaJosa(found),
                approvedRo: pickEuroJosa(approved),
              })}
            </p>
          );
        })() : null}
        {adoptOutcome?.result === 'ambiguous' ? (
          <div className="space-y-1" data-testid="boost-adopt-ambiguous">
            <p className="text-xs text-muted-foreground">{t('boostAdoptAmbiguous')}</p>
            <ul className="text-xs text-foreground">
              {adoptOutcome.candidates.map((c) => (
                <li key={c.id ?? ''} className="break-all">{c.name} · {c.id}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {/* story #4412 — one stop before money moves, the same shape as the start confirmation (what · money · conditions);
            no checkbox: the server itself checks that it exists, is the only one and carries the approved budget */}
        <Dialog open={adoptOpen} onOpenChange={setAdoptOpen}>
          <DialogContent data-testid="boost-adopt-dialog">
            <DialogHeader>
              <DialogTitle>{t('boostAdoptTitle')}</DialogTitle>
              <DialogDescription>{t('boostAdoptWhat')}</DialogDescription>
            </DialogHeader>
            <div className="space-y-1 text-sm">
              {command.campaign_name ? (
                <p className="text-muted-foreground" data-testid="boost-adopt-campaign">
                  {t('boostNeedsCheckCampaignToFind', { campaignName: command.campaign_name })}
                </p>
              ) : null}
              <p className="text-foreground" data-testid="boost-adopt-weight">{t('boostAdoptWeight')}</p>
            </div>
            {sealedFacts}
            <DialogFooter>
              <Button variant="outline" onClick={() => setAdoptOpen(false)} disabled={adopting}>
                {t('boostExecutionCancel')}
              </Button>
              <Button onClick={() => void doAdoptExisting()} disabled={adopting} data-testid="boost-adopt-confirm">
                {t('boostAdoptConfirm')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <Dialog
          open={needsCheckOpen}
          onOpenChange={(open) => { setNeedsCheckOpen(open); if (!open) setNeedsCheckConfirmed(false); }}
        >
          <DialogContent data-testid="boost-needs-check-dialog">
            <DialogHeader>
              <DialogTitle>{t('boostNeedsCheckConfirmTitle')}</DialogTitle>
              <DialogDescription>
                {outcomeUnknown ? t('boostNeedsCheckWhatOutcomeUnknown') : t('boostNeedsCheckWhatStopped')}
              </DialogDescription>
            </DialogHeader>
            {outcomeUnknown ? (
              <div className="space-y-1 text-sm">
                {/* the weight of a wrong confirmation, then what to look for (Yuna 23:18Z) */}
                <p className="text-foreground" data-testid="boost-needs-check-weight">{t('boostNeedsCheckWeightOutcomeUnknown')}</p>
                {command.campaign_name ? (
                  <p className="text-muted-foreground" data-testid="boost-needs-check-campaign">
                    {t('boostNeedsCheckCampaignToFind', { campaignName: command.campaign_name })}
                  </p>
                ) : null}
              </div>
            ) : null}
            {/* the same two steps as the post screen's needs_check retry: the confirm button stays locked until checked */}
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox" checked={needsCheckConfirmed}
                onChange={(e) => setNeedsCheckConfirmed(e.target.checked)}
                data-testid="boost-needs-check-confirm-checklist"
              />
              {outcomeUnknown ? t('boostNeedsCheckConfirmNoCampaign') : t('boostNeedsCheckConfirmChecked')}
            </label>
            <DialogFooter>
              <Button variant="outline" onClick={() => setNeedsCheckOpen(false)} disabled={submitting}>
                {t('boostExecutionCancel')}
              </Button>
              <Button
                onClick={() => void doRetryStart()} disabled={submitting || !needsCheckConfirmed}
                data-testid="boost-needs-check-confirm"
              >
                {t('boostNeedsCheckRetry')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        {cancelControls}
      </div>
    );
  }

  // story #4447 — a start that stopped (not for a person to check): the true line and its way on, never «홍보 시작» (which only
  // returned the same stopped command). The retry button only where the server says this person may retry (`retryable`).
  // Qadir 4870 ① — `blocked_unapproved`: the worker stopped the start before any call (approval gone · connection or source
  // missing); its reason code says why and what next. No retry (approving again makes a new command).
  if (command && !runActive && (command.status === 'dead_letter' || command.status === 'blocked' || command.status === 'failed'
    || command.status === 'blocked_unapproved')) {
    const kind = command.failure_kind;
    const code = command.error_code;
    // Qadir 4870 ② — the server's `retryable` alone (human_retryable · people only): a connection-blocked start it lets a person
    // retry after reconnecting now has its button; the card no longer re-filters by kind
    const retryable = command.retryable === true;
    const link = (chunks: ReactNode) => <Link href={connectRulesHref} className="underline">{chunks}</Link>;
    // Yuna 03:03Z — «— 다시 시도해 주세요» only where the retry button is shown; without it the line stops at the fact
    const connectionLine = () => (retryable ? t.rich('boostStartFailedConnectionRetry', { link }) : t.rich('boostStartFailedConnection', { link }));
    // Yuna 06:12Z — blocked_unapproved lines by the reason code the worker writes (ads_boost_execution._resolve_execution_context)
    const line = command.status === 'blocked_unapproved'
      ? (code === 'ADS_BOOST_GATE_NOT_APPROVED' ? t('boostStartBlockedApprovalGone')
        : code === 'ADS_BOOST_CONNECTION_UNAVAILABLE' ? connectionLine()
        : code === 'ADS_BOOST_ORIGINAL_PUBLICATION_MISSING' ? t('boostStartBlockedPostMissing')
        : code === 'ADS_BOOST_ORIGIN_CONNECTION_MISSING' ? t.rich('boostStartBlockedOriginConnection', { link })
        : t('boostStartBlocked'))
      : kind === 'not_sent' ? (retryable ? t('boostStartFailedNotSent') : t('boostStartFailedNotSentNoRetry'))
      : kind === 'transient' ? (retryable ? t('boostStartFailedTransient') : t('boostStartFailedTransientNoRetry'))
      : kind === 'connection' ? connectionLine()
      : kind === 'paused' ? t('boostStartFailedPaused')
      : t('boostStartBlocked');
    return (
      <div className="space-y-2 break-keep" data-testid="boost-execution-control">
        {actionError ? <p className="text-xs text-destructive" data-testid="boost-execution-error">{actionError}</p> : null}
        <p className="text-xs text-muted-foreground" data-testid="boost-start-failed">{line}</p>
        {retryable ? (
          <Button variant="outline" size="sm" disabled={submitting} onClick={() => void doRetryStart()} data-testid="boost-start-failed-retry">
            {t('boostNeedsCheckRetry')}
          </Button>
        ) : null}
        {cancelControls}
      </div>
    );
  }

  if (!runActive) {
    // 아직 시작 前(run_status=null·pending·failed는 이 조각에선 미시작과 동형 취급 —
    // failed 재시도는 범위 밖). starts_at 자체가 없으면(그라운딩 갭 — 이론상 불가,
    // 봉인 5필드 필수) 버튼을 안 그린다(지어내지 않는다).
    if (!sealedAdsStartsAt) return null;
    const startsAtMs = new Date(sealedAdsStartsAt).getTime();
    const beforeStart = startsAtMs > Date.now();
    return (
      <div className="space-y-2 break-keep" data-testid="boost-execution-control">
        {actionError ? <p className="text-xs text-destructive" data-testid="boost-execution-error">{actionError}</p> : null}
        {waitingLine}
        {capNoticeBlock}
        <Button
          variant="outline" size="sm" disabled={beforeStart || waiting === 'start'}
          onClick={() => setStartConfirmOpen(true)} data-testid="boost-start-trigger"
        >
          {t('boostExecutionStart')}
        </Button>
        {beforeStart ? (
          <p className="text-xs text-muted-foreground" data-testid="boost-start-before-schedule">
            {t('boostExecutionStartBeforeSchedule', { date: formatScheduledAt(sealedAdsStartsAt, teamTz, displayTimezone).display })}
          </p>
        ) : null}

        <Dialog open={startConfirmOpen} onOpenChange={setStartConfirmOpen}>
          <DialogContent data-testid="boost-start-confirm-dialog">
            <DialogHeader>
              <DialogTitle>{t('boostExecutionStartConfirmTitle')}</DialogTitle>
              <DialogDescription>{t('boostExecutionStartConfirmDescription')}</DialogDescription>
            </DialogHeader>
            {/* 봉인 3값 그대로 재확인(페드루 PO 콜①) — RecipeApprovalFactsBlock과 같은
                포맷터 재사용(formatMinorCurrency·formatScheduledAt), 새 표시 로직 0. */}
            {sealedFacts}
            <DialogFooter>
              <Button variant="outline" onClick={() => setStartConfirmOpen(false)} disabled={submitting}>
                {t('boostExecutionCancel')}
              </Button>
              <Button
                onClick={() => void doAction('start', () => setStartConfirmOpen(false))}
                disabled={submitting} data-testid="boost-start-confirm"
              >
                {submitting ? t('boostExecutionStarting') : t('boostExecutionStartConfirm')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        {cancelControls}
        {previousCyclesBlock}
      </div>
    );
  }

  return (
    <div className="space-y-2 break-keep" data-testid="boost-execution-control">
      <p className="text-xs">
        <span className="font-medium text-foreground">
          {/* story #4447 — a pause not landed yet: the campaign still runs (the «중지 중…» line and the cap say the rest) */}
          {runStatus === 'paused' ? t('boostExecutionStatusPaused') : t('boostExecutionStatusRunning')}
        </span>
      </p>
      {/* story #3806 PR 9②(PR8 #4185) — initiated_by 없으면(PR8 미착지·boost_start
          커맨드 자체가 없는 과거 데이터 등) 조용히 숨는다(지어내지 않는다). scheduler는
          봉인 starts_at(이미 아는 값, 새 타임스탬프 필드 0)을 그대로 보여준다. */}
      {initiatedBy === 'human' ? (
        <p className="text-xs text-muted-foreground" data-testid="boost-execution-initiated-by">
          {t('boostExecutionInitiatedByHuman')}
        </p>
      ) : initiatedBy === 'scheduler' ? (
        <p className="text-xs text-muted-foreground" data-testid="boost-execution-initiated-by">
          {t('boostExecutionInitiatedByScheduler', {
            date: sealedAdsStartsAt ? formatScheduledAt(sealedAdsStartsAt, teamTz, displayTimezone).display : '',
          })}
        </p>
      ) : null}
      {/* story #4417 — paused by the server because the spend can't be checked against the budget: said once the pause is
          in effect (before that the card is still «pausing»), with the way to check what was spent (meta only) — Yuna */}
      {/* story #4461 (PO 09:00Z) — a pause that could not reach the campaign's account (its connection gone · token dead): we did
          not stop it, so it is never drawn as a pause — the person stops it in Ads Manager, or reconnects and presses pause again */}
      {(runStatus === 'running' || runStatus === 'pause_pending') && pauseStoppedOnConnection(pauseCommand) ? (
        <div className="space-y-1 text-xs break-keep" data-testid="boost-pause-connection-lost">
          <p className="text-foreground">{t('boostPauseConnectionLost')}</p>
          {runAd.campaign_name ? (
            <p className="text-muted-foreground">{t('boostNeedsCheckCampaignToFind', { campaignName: runAd.campaign_name })}</p>
          ) : null}
          {runAd.ad_channel === 'meta_ads' ? (
            <a
              href={adsManagerCampaignUrl(runAd.ad_account_id, runAd.campaign_id)} target="_blank" rel="noopener noreferrer"
              className="block text-primary hover:underline" data-testid="boost-ads-manager-link"
            >
              {/* Yuna 10:29Z — the same words as the cap notice's link for the same act */}
              {t('boostExecutionStopInAdsManager')}<span aria-hidden="true"> ↗</span>
            </a>
          ) : null}
          <p className="text-muted-foreground">
            {/* Yuna 13:12Z — a link standing on its own line: the same shape as the Ads Manager link above */}
            {t.rich('boostPauseConnectionLostReconnect', { link: (chunks) => <Link href={connectRulesHref} className="text-primary hover:underline" data-testid="boost-pause-reconnect">{chunks}</Link> })}
          </p>
        </div>
      ) : null}
      {spendBlockedCode === SPEND_CONTEXT_LOST ? (
        // shown whatever the run status says: we could not pause it ourselves
        <div className="space-y-1 text-xs" data-testid="boost-spend-blocked">
          <p className="text-foreground" data-testid="boost-spend-context-lost">{t('boostSpendContextLost')}</p>
          {/* the connection is gone, so there is usually no account to link to: name the campaign to look for (Yuna) */}
          {runAd.campaign_name ? (
            <p className="text-muted-foreground" data-testid="boost-spend-context-lost-campaign">
              {t('boostNeedsCheckCampaignToFind', { campaignName: runAd.campaign_name })}
            </p>
          ) : null}
          {runAd.ad_channel === 'meta_ads' ? (
            <a
              href={adsManagerCampaignUrl(runAd.ad_account_id, runAd.campaign_id)} target="_blank" rel="noopener noreferrer"
              className="text-primary hover:underline" data-testid="boost-ads-manager-link"
            >
              {t('boostOpenAdsManager')}<span aria-hidden="true"> ↗</span>
            </a>
          ) : null}
        </div>
      ) : spendBlockedCode && runStatus === 'paused' ? (
        <div className="space-y-1 text-xs" data-testid="boost-spend-blocked">
          <p className="text-muted-foreground" data-testid="boost-spend-unreadable">{isSpendCurrencyCode(spendBlockedCode) ? t('boostSpendUnreadablePaused') : t('boostSpendUncheckedPaused')}</p>
          {/* the same link shape as the cap notice (4820): its own line · text-primary · ↗ */}
          {runAd.ad_channel === 'meta_ads' ? (
            <a
              href={adsManagerCampaignUrl(runAd.ad_account_id, runAd.campaign_id)} target="_blank" rel="noopener noreferrer"
              className="text-primary hover:underline" data-testid="boost-ads-manager-link"
            >
              {t('boostOpenAdsManager')}<span aria-hidden="true"> ↗</span>
            </a>
          ) : null}
        </div>
      ) : null}
      {/* story #4466 (PO 11:51Z) — the gate went back to review: the server paused the boost (no money on values nobody approves).
          Facts only — no «resume once approved»: a lower-budget re-approval leaves the campaign on another budget (4458) */}
      {offApproved && runStatus === 'paused' ? (
        <p className="text-xs text-muted-foreground" data-testid="boost-paused-approval-gone">{t('boostPausedApprovalGone')}</p>
      ) : null}
      {actionError ? <p className="text-xs text-destructive" data-testid="boost-execution-error">{actionError}</p> : null}
      {waitingLine}
      {capNoticeBlock}
      {spendBlockedCode === SPEND_CONTEXT_LOST || runStatus === 'pause_pending' ? null /* no connection · or a pause already requested */ : runStatus === 'running' ? (
        <Button
          variant="outline" size="sm" disabled={submitting || waiting === 'pause'}
          onClick={() => setPauseConfirmOpen(true)} data-testid="boost-pause-trigger"
        >
          {t('boostExecutionPause')}
        </Button>
      ) : spendBlockedCode || offApproved ? null /* story #4417 — resuming would spend with no cap · story #4466 — or on a gate
          back in review (the server refuses both) */ : (
        <Button
          variant="outline" size="sm" disabled={submitting || waiting === 'resume'}
          onClick={() => void doAction('resume', () => {})} data-testid="boost-resume-trigger"
        >
          {submitting ? t('boostExecutionResuming') : t('boostExecutionResume')}
        </Button>
      )}
      {cancelControls}
      {/* story #3806(PR 12) — 자연 스케줄(+1d/+7d)을 기다리지 않고 즉시 1회
          캡처. comments/refresh와 동형 손잡이(같은 5분 rate-limit 사상). */}
      <Button
        variant="outline" size="sm" disabled={refreshingSpend}
        onClick={() => void doRefreshSpend()} data-testid="boost-spend-refresh-trigger"
      >
        {refreshingSpend ? t('boostExecutionSpendRefreshing') : t('boostExecutionSpendRefresh')}
      </Button>
      {spendRefreshError ? (
        <p className="text-xs text-muted-foreground" data-testid="boost-spend-refresh-error">{spendRefreshError}</p>
      ) : lastRefresh && sealedAdsCurrency ? (
        // story #3806(Phase3·3-2 PR 12, 페드루 PO 실측 캡처 2026-09-11 18:16Z) —
        // 성공 경로가 화면에 아무 변화가 없어 "눌렀는데 아무 일도 없었다"로 읽히던
        // 결함 처방. 실패(429/error) 문구와 자리를 공유(동시에 둘 다 보일 이유 0).
        <p className="text-xs text-muted-foreground" data-testid="boost-spend-refresh-success">
          {t('boostExecutionSpendRefreshedNotice', {
            amount: formatMinorCurrency(lastRefresh.spendMinor, sealedAdsCurrency as GenerationBudgetCurrency, locale, tContent),
            time: formatViewerRelativeTime(lastRefresh.capturedAt, locale, displayTimezone),
          })}
        </p>
      ) : null}

      {/* story #3806(유나 §절 §2 「비용 명확」) — 확認 다이얼로그 문구는 §절 원문 그대로. */}
      {previousCyclesBlock}
      <Dialog open={pauseConfirmOpen} onOpenChange={setPauseConfirmOpen}>
        <DialogContent data-testid="boost-pause-confirm-dialog">
          <DialogHeader>
            <DialogTitle>{t('boostExecutionPauseConfirmTitle')}</DialogTitle>
            <DialogDescription>{t('boostExecutionPauseConfirmDescription')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPauseConfirmOpen(false)} disabled={submitting}>
              {t('boostExecutionCancel')}
            </Button>
            <Button
              onClick={() => void doAction('pause', () => setPauseConfirmOpen(false))}
              disabled={submitting} data-testid="boost-pause-confirm"
            >
              {submitting ? t('boostExecutionPausing') : t('boostExecutionPauseConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
