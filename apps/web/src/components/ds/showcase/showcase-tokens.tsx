'use client';

import { Block, Row } from './showcase-layout';

/** 색 — 클래스를 통째로 적어야 Tailwind가 알아본다. 이름은 `--ds-*` 뜻 이름. */
const COLORS: Array<{ name: string; swatch: string }> = [
  { name: 'surface-sunk', swatch: 'bg-ds-surface-sunk' },
  { name: 'background', swatch: 'bg-ds-background' },
  { name: 'surface', swatch: 'bg-ds-surface' },
  { name: 'surface-raised', swatch: 'bg-ds-surface-raised' },
  { name: 'surface-high', swatch: 'bg-ds-surface-high' },
  { name: 'surface-highest', swatch: 'bg-ds-surface-highest' },
  { name: 'line', swatch: 'bg-ds-line' },
  { name: 'line-strong', swatch: 'bg-ds-line-strong' },
  { name: 'line-control', swatch: 'bg-ds-line-control' },
  { name: 'ink', swatch: 'bg-ds-ink' },
  { name: 'ink-2', swatch: 'bg-ds-ink-2' },
  { name: 'ink-3', swatch: 'bg-ds-ink-3' },
  { name: 'action', swatch: 'bg-ds-action' },
  { name: 'on-action', swatch: 'bg-ds-on-action' },
  { name: 'action-text', swatch: 'bg-ds-action-text' },
  { name: 'action-soft', swatch: 'bg-ds-action-soft' },
  { name: 'mine', swatch: 'bg-ds-mine' },
  { name: 'needs-hand', swatch: 'bg-ds-needs-hand' },
  { name: 'needs-hand-bar', swatch: 'bg-ds-needs-hand-bar' },
  { name: 'on-needs-hand', swatch: 'bg-ds-on-needs-hand' },
  { name: 'needs-hand-soft', swatch: 'bg-ds-needs-hand-soft' },
  { name: 'done', swatch: 'bg-ds-done' },
  { name: 'done-soft', swatch: 'bg-ds-done-soft' },
  { name: 'failed', swatch: 'bg-ds-failed' },
  { name: 'failed-soft', swatch: 'bg-ds-failed-soft' },
  { name: 'info', swatch: 'bg-ds-info' },
  { name: 'info-soft', swatch: 'bg-ds-info-soft' },
  { name: 'scrim', swatch: 'bg-ds-scrim' },
];

const TYPE_SCALE: Array<{ name: string; cls: string; spec: string }> = [
  { name: 'title', cls: 'text-ds-title font-semibold', spec: '18 / 24' },
  { name: 'card-title', cls: 'text-ds-card-title font-semibold', spec: '14 / 20' },
  { name: 'body', cls: 'text-ds-body', spec: '13 / 20' },
  { name: 'small', cls: 'text-ds-small', spec: '12 / 16' },
  { name: 'mono-lg', cls: 'font-mono text-ds-mono-lg', spec: '13 / 18' },
  { name: 'mono-md', cls: 'font-mono text-ds-mono-md', spec: '11 / 16' },
  { name: 'mono-sm', cls: 'font-mono text-ds-mono-sm', spec: '11 / 14' },
];

const RADII: Array<{ name: string; cls: string; px: string }> = [
  { name: 'tag', cls: 'rounded-ds-tag', px: '2' },
  { name: 'control', cls: 'rounded-ds-control', px: '4' },
  { name: 'panel', cls: 'rounded-ds-panel', px: '8' },
  { name: 'pill', cls: 'rounded-ds-pill', px: '12' },
];

const DENSITY: Array<{ name: string; cls: string; px: string; use: string }> = [
  { name: 'control-sm', cls: 'h-ds-control-sm', px: '28', use: '작은 단추' },
  { name: 'compact', cls: 'h-ds-compact', px: '32', use: '탭 · 메뉴 항목 · 달력 칸' },
  { name: 'control', cls: 'h-ds-control', px: '36', use: '큰 단추 · 입력칸' },
  { name: 'touch', cls: 'h-ds-touch', px: '44', use: '폰 바닥' },
  { name: 'control-xl', cls: 'h-ds-control-xl', px: '48', use: '큰 아이콘 단추' },
  { name: 'row', cls: 'h-ds-row', px: '56', use: '목록 줄' },
];

/** 토큰 한눈에 — 색(밝음/어둠은 바깥 틀이 가른다) · 글자 · 모서리 · 밀도 · 그림자 · 움직임. 이름 = 코드의 이름. */
export function ShowcaseTokens() {
  return (
    <>
      <Block title="색 — 뜻 이름 28종 (--ds-*)">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2">
          {COLORS.map((c) => (
            <div key={c.name} className="flex items-center gap-2 rounded-ds-control border border-ds-line bg-ds-surface p-1.5">
              <span aria-hidden="true" className={`size-ds-control-sm shrink-0 rounded-ds-tag border border-ds-line ${c.swatch}`} />
              <span className="min-w-0 truncate font-mono text-ds-mono-md text-ds-ink-2">{c.name}</span>
            </div>
          ))}
        </div>
      </Block>
      <Block title="글자 눈금 (text-ds-*)">
        <div className="flex flex-col gap-1.5">
          {TYPE_SCALE.map((t) => (
            <div key={t.name} className="flex items-baseline gap-3">
              <span className="w-24 shrink-0 font-mono text-ds-mono-md text-ds-ink-3">{t.name}</span>
              <span className={`${t.cls} min-w-0 text-ds-ink`}>같은 데이터, 다른 눈금 Aa 123</span>
              <span className="ml-auto shrink-0 font-mono text-ds-mono-md text-ds-ink-3">{t.spec}</span>
            </div>
          ))}
        </div>
      </Block>
      <Block title="모서리 (rounded-ds-*)">
        <Row>
          {RADII.map((r) => (
            <div key={r.name} className="flex flex-col items-center gap-1">
              <span aria-hidden="true" className={`size-ds-row border border-ds-line-control bg-ds-surface-high ${r.cls}`} />
              <span className="font-mono text-ds-mono-md text-ds-ink-2">{r.name} {r.px}</span>
            </div>
          ))}
        </Row>
      </Block>
      <Block title="밀도 — 누르는 높이 (h-ds-*)">
        <div className="flex flex-col gap-1.5">
          {DENSITY.map((d) => (
            <div key={d.name} className="flex items-center gap-3">
              <span className="w-28 shrink-0 font-mono text-ds-mono-md text-ds-ink-2">{d.name} {d.px}</span>
              <span aria-hidden="true" className={`${d.cls} w-24 shrink-0 rounded-ds-control border border-ds-line-control bg-ds-surface-high`} />
              <span className="text-ds-small text-ds-ink-3">{d.use}</span>
            </div>
          ))}
        </div>
      </Block>
      <Block title="그림자 (shadow-ds-*)">
        <Row>
          <div className="flex flex-col items-center gap-1">
            <span aria-hidden="true" className="size-ds-row w-32 rounded-ds-panel border border-ds-line bg-ds-surface-raised shadow-ds-popup" />
            <span className="font-mono text-ds-mono-md text-ds-ink-2">popup — 토스트 · 달력 팝업</span>
          </div>
          <div className="flex flex-col items-center gap-1">
            <span aria-hidden="true" className="size-ds-row w-32 rounded-ds-panel border border-ds-line bg-ds-surface-raised shadow-ds-overlay" />
            <span className="font-mono text-ds-mono-md text-ds-ink-2">overlay — 대화창 · 패널 · 메뉴</span>
          </div>
        </Row>
      </Block>
      <Block title="움직임 (--ds-duration-*)">
        <Row>
          <span className="font-mono text-ds-mono-md text-ds-ink-2">fast 100ms · instant 0ms(움직임 줄이기) · pulse 2s · enter 300ms(토스트 들어오기)</span>
          <span className="inline-flex items-center gap-2 text-ds-small text-ds-ink-2">
            <span aria-hidden="true" className="size-2 rounded-full bg-ds-action motion-safe:animate-ds-pulse" />
            불러오는 중 숨쉬기
          </span>
          <span className="rounded-ds-control border border-ds-line-control px-3 py-1 text-ds-small text-ds-ink transition-colors duration-(--ds-duration-fast) motion-reduce:transition-none hover:bg-ds-surface-high">올려 보기 (100ms)</span>
        </Row>
      </Block>
    </>
  );
}
