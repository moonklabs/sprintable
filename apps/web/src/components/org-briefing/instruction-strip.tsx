'use client';

// The corner for the round support button (PO 11-14): the row and the failure line keep their right 56px free WHILE THE BUTTON CAN MEET THEM. The button stands in the strip's own bottom room (1rem + the clear) — until a toast
// or a banner shows: BottomDock stacks banner → toasts → button (flex-col-reverse), so the button rises by the toast's height and, on a narrow pane, sits over the row's right end ([보내기] on a phone · at 1100).
// It can only meet the row where the body column reaches the button's box: the column is centred and capped (`max-w-4xl`), so when the PANE is at least column + 2 × (button + its offset) wide the button is outside the
// column whatever the toasts do, and the corner is given back (the row ends at the cards' edge). The pane's width is what matters, not the window's (the sidebar folds and unfolds): it is measured here, and the cap is read
// from the column's own CSS (one source — no second number). Not measured yet / no ResizeObserver / no cap → the corner stays kept (the safe side).
// story 4906 (lap 3) — the home's one-line instruction strip, moved out of org-briefing-shell.tsx so a layout spec can mount it alone on a real scroller.
// The strip is the LAST thing in the body pane (dashboard-shell's `overflow-y-auto` scroller) and stays pinned to the pane's bottom edge. PO 11-14 (dev c8ababa4a, measured):
// the pane has `pb-[var(--shell-launcher-clear)]` (64px + safe area, kept free for the round support button) and a sticky `bottom-0` stops at the pane's content edge, so a 64px band
// below the strip showed the cards scrolling by — on a phone the «오늘 결과» card appeared UNDER the strip and its title was hidden behind it (the order read strip → card, the desktop's is card → strip).
// Now the strip reaches the pane's bottom edge (negative sticky offset by the clear · negative margin by the clear PLUS the body root's own bottom padding p-4 / lg:p-6, so at the end of the scroll it also stands on the edge), is opaque, and carries its own bottom room (1rem + the clear: the support button and
// the safe area sit INSIDE the strip), with one `ds-line` rule on top where the content passes behind it.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { Button } from '@/components/ds/button';
import { Input } from '@/components/ds/input';
import { useFlatHref } from '@/hooks/use-flat-href';
import { findSoleAgentDm, sendInstruction } from '@/lib/today-instruct';

/** The corner kept free for the round support button (a class literal on purpose: Tailwind reads it as written; `<html data-support-launcher>` is set only while the button is drawn). */
const KEEP_CORNER = '[:root[data-support-launcher]_&]:pe-14';
/** the round support button's reach from the window edge: its 48px (h-12 w-12) + the dock's 16px offset (BottomDock `right-4`) */
const BUTTON_SPAN_PX = 64;

/** true once the pane is wide enough that the body column ends before the support button's box (see the header); false = keep the corner */
function useColumnClearOfButton(stripRef: { current: HTMLElement | null }): boolean {
  const [clear, setClear] = useState(false);
  useLayoutEffect(() => {
    const strip = stripRef.current;
    const column = strip?.parentElement ?? null; // the body root: `mx-auto w-full max-w-4xl …`
    let pane: HTMLElement | null = column?.parentElement ?? null;
    while (pane && !/(auto|scroll)/.test(getComputedStyle(pane).overflowY)) pane = pane.parentElement;
    if (!column || !pane) return;
    const measure = () => {
      const cap = parseFloat(getComputedStyle(column).maxWidth); // `none` → NaN → the corner stays kept
      setClear(Number.isFinite(cap) && pane!.clientWidth >= cap + 2 * BUTTON_SPAN_PX);
    };
    // no ResizeObserver (an old WebView): a one-time measurement would go stale when the sidebar folds / unfolds — the corner stays kept (the safe side), never given back on a single reading
    if (typeof ResizeObserver === 'undefined') return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(pane);
    return () => observer.disconnect();
  }, [stripRef]);
  return clear;
}

function InstructionInput({ autoFocus, keepCorner }: { autoFocus: boolean; keepCorner: boolean }) {
  const flatHref = useFlatHref(); // story #4231 — flat 링크 `?p=`
  const t = useTranslations('orgBriefing');
  const router = useRouter();
  const { projectId, currentTeamMemberId } = useDashboardContext();
  const [value, setValue] = useState('');
  // story #4762 (AC1) — one press sends when the person has exactly one agent DM; `sending` holds a second press, `failed` keeps the text and says so
  const [sending, setSending] = useState(false);
  // what the line under the box says: a refusal · no answer at all · «it was sent, to the project you have just left»
  const [failed, setFailed] = useState<null | 'refused' | 'unknown' | 'elsewhere'>(null);
  const sendingRef = useRef(false); // a second press in the same tick sees the state of the render before — the ref holds it at once
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  const projectRef = useRef(projectId);
  // the project the person is on NOW — the answer of a read made on another project must not send anything. A LAYOUT effect: it runs inside the commit, so no
  // continuation of an earlier press can run between «the new project is on screen» and «the ref knows» (a passive effect leaves that gap — codex 4762)
  useLayoutEffect(() => { projectRef.current = projectId; }, [projectId]);
  const inputRef = useRef<HTMLInputElement>(null);

  // story #3831 후속(페드루 PO 確定, 2026-09-13 14:22Z) — 컴패니언 단축키가 `?focus=compose`
  // 딥링크로 이 화면을 열면 하단 지시 한 줄에 바로 포커스한다(웹은 포커스만 — 단축키 자체는
  // 3832, 데스크톱 전용 축).
  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed || sendingRef.current) return;
    setFailed(null);
    // story #3831 PO 確定(c)(2026-09-13 14:04Z) — 수신자 발명 0. 「대화」의 기존 두 경로
    // (최근 대화 프리필 / 0건이면 새 대화 모달, chat-list-view.tsx 참고)로 위임만 한다.
    const handOver = () => router.push(flatHref(`/chats?compose=${encodeURIComponent(trimmed)}`));
    if (!projectId || !currentTeamMemberId) { handOver(); return; }
    // story #4762 (AC1, PO 10-24) — the person's ONE agent DM is not a receiver invented for them (it is the only one there is): a plain
    // message goes there at once, and the person lands on that DM where the answer arrives. Anything else keeps the hand-over above.
    sendingRef.current = true;
    setSending(true);
    const target = await findSoleAgentDm(projectId, currentTeamMemberId);
    // the person left the screen, or moved to another project, while the list was being read: nothing is sent (the DM found belongs to the project they left)
    if (!mountedRef.current || projectRef.current !== projectId) { sendingRef.current = false; if (mountedRef.current) setSending(false); return; }
    if (!target) { sendingRef.current = false; setSending(false); handOver(); return; }
    const outcome = await sendInstruction(target, trimmed);
    sendingRef.current = false;
    if (!mountedRef.current) return; // sent, and the person has gone elsewhere: no state to set, nowhere to take them
    setSending(false);
    if (outcome !== 'sent') { setFailed(outcome); return; }
    setValue('');
    // it went to the DM of the project the person WAS on: if they moved to another project during the send, they are not taken back to the one they left
    if (projectRef.current !== projectId) { setFailed('elsewhere'); return; } // not a failure — it IS sent; the line says where it went
    // 대상-프로젝트: 현재 p가 곧 대상 프로젝트다 — findSoleAgentDm이 현재 프로젝트(project_id=현재)의 대화 목록만 읽어 고른 대화다.
    router.push(flatHref(`/chats/${encodeURIComponent(target)}`));
  };

  return (
    // story #4762 (AC3 · the button sat on [Send] on a phone) · story 4906 (the same at 1100): the corner stays kept while the button can meet the row — see the header and KEEP_CORNER / useColumnClearOfButton above.
    <>
    <form onSubmit={handleSubmit} className={`flex items-center gap-2 border-t border-ds-line pt-4${keepCorner ? ` ${KEEP_CORNER}` : ''}`} data-testid="today-instruction-form">
      <Input
        ref={inputRef}
        value={value}
        onChange={(e) => { setValue(e.target.value); setFailed(null); }} // a line under the box is about the text that was there — a new edit puts it away
        placeholder={t('instructionInputPlaceholder')}
        aria-label={t('instructionInputPlaceholder')}
        data-testid="today-instruction-input"
        disabled={sending}
      />
      <Button type="submit" variant="primary" size="md" disabled={!value.trim()} loading={sending}>{t('instructionSendButton')}</Button>
    </form>
    {failed ? <p role={failed === 'elsewhere' ? 'status' : 'alert'} data-testid="today-instruction-failed" className={`mt-2 text-xs${keepCorner ? ` ${KEEP_CORNER}` : ''} ${failed === 'elsewhere' ? 'text-muted-foreground' : 'text-destructive'}`}>{failed === 'unknown' ? t('instructionSendUnknown') : failed === 'elsewhere' ? t('instructionSentElsewhere') : t('instructionSendFailed')}</p> : null}
    </>
  );
}

/** The strip: the instruction row on an opaque face pinned to the bottom edge of the body pane. */
export function InstructionStrip({ autoFocus }: { autoFocus: boolean }) {
  const stripRef = useRef<HTMLDivElement>(null);
  const clearOfButton = useColumnClearOfButton(stripRef);
  return (
    <div
      ref={stripRef}
      data-testid="today-instruction-strip"
      className="sticky bottom-[calc(-1*var(--shell-launcher-clear,0px))] -mx-4 mb-[calc(-1*(var(--shell-launcher-clear,0px)_+_1rem))] bg-ds-background px-4 pb-[calc(1rem+var(--shell-launcher-clear,0px))] lg:-mx-6 lg:mb-[calc(-1*(var(--shell-launcher-clear,0px)_+_1.5rem))] lg:px-6"
    >
      <InstructionInput autoFocus={autoFocus} keepCorner={!clearOfButton} />
    </div>
  );
}
