'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { usePhoneBridge } from '@/components/providers/phone-bridge-context';
import { useViewerTimeZone } from '@/components/viewer-time-zone';
import { formatLocaleDateTime } from '@/lib/i18n';
import { readStartableKeyed } from '@/lib/phone-start';
import { deleteRoomRecords, readRecordsAll, type OpenLine, type RecordsPage, type RecordsOutcome } from '@/lib/phone-records';

/**
 * story 4977 (B3-2b) — the «기록» sheet of an agent's chat in the phone app: what the person told the agent and what they answered to its questions, kept for them as SEALED records the server cannot read.
 * The sheet reads the whole history of the room (the server lists oldest first, so the NEWEST lines are only reached by reading on) and opens at its END; [더 불러오기] above shows earlier lines of what was read,
 * and one below continues a history longer than one opening reads. Every line was opened by the phone's shell (`records.open`): the page holds no key and no envelope — a row the shell could not open is only
 * counted, in one line per reason. The words are the strip's own namespace (`chats.agentSession.records`).
 */
const SHOWN_STEP = 30;

type T = ReturnType<typeof useTranslations<'chats.agentSession.records'>>;
// the words are named one by one (not built from the problem's name): a key that is spelled out can be found by the dead-key scan, and by a person grepping for it
const PROBLEM_TEXT: Record<'failed' | 'notPaired' | 'notAllowed' | 'unsupported', (t: T) => string> = {
  failed: (t) => t('problem.failed'),
  notPaired: (t) => t('problem.notPaired'),
  notAllowed: (t) => t('problem.notAllowed'),
  unsupported: (t) => t('problem.unsupported'),
};

type View =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'page'; page: RecordsPage }
  | { kind: 'problem'; problem: 'failed' | 'notPaired' | 'notAllowed' | 'unsupported' };

const problemOf = (o: Exclude<RecordsOutcome, { kind: 'page' }>): 'failed' | 'notPaired' | 'notAllowed' | 'unsupported' => {
  if (o.kind === 'not_paired') return 'notPaired';
  if (o.kind === 'not_allowed' || o.kind === 'room_not_found') return 'notAllowed';
  if (o.kind === 'unsupported') return 'unsupported';
  return 'failed'; // key · signed out · unreachable · failed: one line, with [다시 불러오기]
};

export function AgentRecordsSheet({ conversationId, setupId, open, onOpenChange }: { conversationId: string; setupId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations('chats.agentSession.records');
  const { phoneCall } = usePhoneBridge();
  const [view, setView] = useState<View>({ kind: 'idle' });
  const [shown, setShown] = useState(SHOWN_STEP);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteFailed, setDeleteFailed] = useState(false);
  const run = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const phoneKey = useRef<string | null>(null);
  const pageRef = useRef<RecordsPage | null>(null); // what is shown now (a continuation adds to it) — a ref, so `read` does not change with every page
  const show = useCallback((v: View) => { pageRef.current = v.kind === 'page' ? v.page : null; setView(v); }, []);

  const read = useCallback(async (after?: number) => {
    const mine = ++run.current;
    const keep = after !== undefined ? pageRef.current : null; // a continuation adds to what is shown
    if (!keep) show({ kind: 'loading' });
    const listed = phoneKey.current ? null : await readStartableKeyed(phoneCall).catch(() => null);
    if (mine !== run.current) return;
    if (listed) {
      if (listed.kind !== 'view') { show({ kind: 'problem', problem: listed.kind === 'no_phone' ? 'notPaired' : 'failed' }); return; }
      phoneKey.current = listed.phoneKeyId;
    }
    const key = phoneKey.current;
    if (!key) { show({ kind: 'problem', problem: 'failed' }); return; }
    const out = await readRecordsAll({ phoneCall, setupId, conversationId, phoneKeyId: key, ...(after !== undefined ? { after } : {}) });
    if (mine !== run.current) return; // a newer opening or a closed sheet: this answer is not drawn
    if (out.kind !== 'page') { show({ kind: 'problem', problem: problemOf(out) }); return; }
    const { kind: _kind, ...page } = out;
    void _kind;
    show({
      kind: 'page',
      page: keep
        ? { ...page, lines: [...keep.lines, ...page.lines], closed: { noKey: keep.closed.noKey + page.closed.noKey, unverified: keep.closed.unverified + page.closed.unverified, unreadable: keep.closed.unreadable + page.closed.unreadable }, haveKey: keep.haveKey || page.haveKey }
        : page,
    });
  }, [phoneCall, setupId, conversationId, show]);

  // every opening reads again (a closed sheet ends its run: whatever is still on its way is not drawn)
  useEffect(() => {
    if (!open) { run.current += 1; return undefined; }
    setShown(SHOWN_STEP);
    setDeleteFailed(false);
    void read();
    return () => { run.current += 1; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- an OPENING, or another room / computer while open, starts a read (`read` itself is made new by the bridge wrapper at every render: not a reason to read again)
  }, [open, setupId, conversationId]);

  // the sheet opens at the END of what was read (the newest line is what a person comes for)
  const pageLines = view.kind === 'page' ? view.page.lines.length : 0;
  useLayoutEffect(() => {
    if (view.kind === 'page' && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [view.kind, pageLines]);

  const remove = async () => {
    setConfirmOpen(false);
    setDeleteFailed(false);
    const at = run.current; // any new opening, read or close moves `run` (and so does a delete that went through — a read still on its way must not paint the deleted history back): a delete that answers after that is not drawn (a reopened sheet reads the history afresh)
    const r = await deleteRoomRecords(conversationId);
    if (at !== run.current) return;
    if (r.kind === 'deleted') { run.current += 1; show({ kind: 'page', page: { lines: [], closed: { noKey: 0, unverified: 0, unreadable: 0 }, haveKey: true, nextAfter: 0, more: false } }); return; }
    setDeleteFailed(true);
  };

  const page = view.kind === 'page' ? view.page : null;
  const lines = page ? page.lines.slice(-shown) : [];
  const hiddenEarlier = page ? page.lines.length - lines.length : 0;
  const nothing = page !== null && page.lines.length === 0 && page.closed.noKey + page.closed.unverified + page.closed.unreadable === 0;
  const keyless = page !== null && !page.haveKey && page.closed.noKey > 0;
  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent data-testid="agent-records-sheet">
          <DialogHeader>
            <DialogTitle>{t('title')}</DialogTitle>
            <DialogDescription className="break-keep">{t('lead')}</DialogDescription>
          </DialogHeader>
          <div ref={scroller} className="max-h-[60vh] min-h-24 overflow-y-auto p-1" data-testid="agent-records-list">
            {view.kind === 'loading' || view.kind === 'idle' ? <p className="py-6 text-center text-sm text-muted-foreground" data-testid="agent-records-loading">{t('loading')}</p> : null}
            {view.kind === 'problem' ? (
              <div className="flex flex-col items-start gap-2 py-4 text-sm" data-testid="agent-records-problem">
                <p className="break-keep">{PROBLEM_TEXT[view.problem](t)}</p>
                {view.problem === 'failed' ? <Button size="sm" variant="outline" onClick={() => void read()} data-testid="agent-records-reload">{t('reload')}</Button> : null}
              </div>
            ) : null}
            {page ? (
              <div className="flex flex-col gap-2 py-2">
                {hiddenEarlier > 0 ? <Button size="sm" variant="outline" className="self-center" onClick={() => setShown((n) => n + SHOWN_STEP)} data-testid="agent-records-earlier">{t('loadMore')}</Button> : null}
                {nothing ? <p className="py-6 text-center text-sm text-muted-foreground" data-testid="agent-records-empty">{t('empty')}</p> : null}
                {keyless ? <p className="py-2 text-sm break-keep text-muted-foreground" data-testid="agent-records-keyless">{t('keyless')}</p> : null}
                {lines.map((l) => <Line key={l.recordId} line={l} />)}
                {!keyless && page.closed.noKey > 0 ? <p className="text-xs text-muted-foreground" data-testid="agent-records-nokey">{t('noKey', { n: page.closed.noKey })}</p> : null}
                {page.closed.unverified > 0 ? <p className="text-xs text-muted-foreground" data-testid="agent-records-unverified">{t('unverified', { n: page.closed.unverified })}</p> : null}
                {page.closed.unreadable > 0 ? <p className="text-xs text-muted-foreground" data-testid="agent-records-unreadable">{t('unreadable', { n: page.closed.unreadable })}</p> : null}
                {page.more ? <Button size="sm" variant="outline" className="self-center" onClick={() => void read(page.nextAfter)} data-testid="agent-records-more">{t('loadMore')}</Button> : null}
              </div>
            ) : null}
          </div>
          {deleteFailed ? <p className="text-xs text-destructive" data-testid="agent-records-delete-failed">{t('delete.failed')}</p> : null}
          <DialogFooter>
            {page && !nothing ? <Button variant="outline" onClick={() => setConfirmOpen(true)} data-testid="agent-records-delete">{t('delete.button')}</Button> : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent showCloseButton={false} initialFocus={cancelRef}>
          <DialogHeader>
            <DialogTitle>{t('delete.title')}</DialogTitle>
            <DialogDescription className="break-keep">{t('delete.body')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button ref={cancelRef} variant="outline" onClick={() => setConfirmOpen(false)}>{t('delete.cancel')}</Button>
            <Button variant="destructive" onClick={() => void remove()} data-testid="agent-records-delete-confirm">{t('delete.confirm')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Line({ line }: { line: OpenLine }) {
  const t = useTranslations('chats.agentSession.records');
  const locale = useLocale();
  const viewerTz = useViewerTimeZone(); // story #4443: a time is shown in the viewer's own zone — and not at all while that is not known (never UTC)
  const when = viewerTz ? formatLocaleDateTime(line.ts, locale, viewerTz) : '';
  const who = line.writer === 'phone' ? t('writerPhone') : t('writerHost');
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2 text-sm" data-testid="agent-records-line" data-kind={line.kind}>
      {line.kind === 'chat_line' ? (
        <p className="break-words whitespace-pre-wrap">{line.text}</p>
      ) : (
        <>
          <p className="font-medium">{line.decision === 'allow' ? t('allowed', { tool: line.tool }) : t('denied', { tool: line.tool })}</p>
          <p className="break-words whitespace-pre-wrap text-muted-foreground">{line.summary}</p>
        </>
      )}
      <p className="mt-1 text-xs text-muted-foreground">{line.kind === 'chat_line' ? `${t('instruction')} · ` : ''}{who}{when ? ` · ${when}` : ''}</p>
    </div>
  );
}
