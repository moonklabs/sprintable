'use client';

import Link from 'next/link';

/**
 * story 5035 (C5 follow-up · PO's Two-Pass on 390) — the «실행 위치» value of the agent detail's summary card: the sentence («지금 도는 컴퓨터: {name} · {state}») and, for those who manage devices, the link to the device list.
 * Moved out of the page as it was (the same markup and test ids) so the layout can be measured in a browser; the two things it fixes:
 *  · the sentence broke in the middle of a word / between the «·» and the state («… · / 끝») at 390 — Korean wraps between syllables unless `break-keep` is on, and the «· state» tail is one unbreakable piece (a long device name still wraps: `overflow-wrap:anywhere`);
 *  · the link stays one piece (`whitespace-nowrap`).
 */
export function ComputerSummaryValue({ line, devicesHref, devicesLabel }: { line: string; devicesHref: string | null; devicesLabel: string }) {
  // «… · 끝»: the «· state» tail is ONE unbreakable piece (it cannot be left alone on the next line; the break may come before the «·» only). The TEXT is unchanged — only its wrapping.
  const cut = line.lastIndexOf(' · ');
  const head = cut >= 0 ? line.slice(0, cut + 1) : line;
  const tail = cut >= 0 ? line.slice(cut + 1) : null;
  return (
    <span data-testid="agent-running-on" className="flex min-w-0 flex-col gap-0.5">
      <span className="break-keep [overflow-wrap:anywhere]" data-testid="agent-running-on-line">
        {head}
        {tail ? <span className="whitespace-nowrap" data-testid="agent-running-on-tail">{tail}</span> : null}
      </span>
      {devicesHref ? (
        <Link href={devicesHref} className="w-fit whitespace-nowrap text-ds-small font-medium text-ds-action-text hover:underline" data-testid="agent-see-devices">
          {devicesLabel}
        </Link>
      ) : null}
    </span>
  );
}
