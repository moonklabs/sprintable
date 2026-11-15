import type { ReactNode } from 'react';

/** 견본 한 덩어리 — 제목 + 내용. */
export function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-5 min-w-0">
      <h3 className="m-0 mb-2 border-b border-ds-line pb-1 text-ds-card-title font-semibold text-ds-ink">{title}</h3>
      {children}
    </section>
  );
}

/** 한 줄에 늘어놓기(넘치면 줄바꿈). */
export function Row({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div className="mb-2 flex min-w-0 flex-wrap items-center gap-2">
      {label ? <span className="w-24 shrink-0 font-mono text-ds-mono-md text-ds-ink-3">{label}</span> : null}
      {children}
    </div>
  );
}
