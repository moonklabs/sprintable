'use client';

import { useEffect, useState } from 'react';

interface ColorToken {
  name: string;
  var: string;
  tailwind: string;
}

interface FontToken {
  name: string;
  var: string;
  tailwind: string;
}

interface RadiusToken {
  name: string;
  var: string;
  tailwind: string;
}

const COLOR_GROUPS: { label: string; tokens: ColorToken[] }[] = [
  {
    label: 'Brand',
    tokens: [
      { name: 'brand', var: '--brand', tailwind: 'bg-brand' },
      { name: 'brand-foreground', var: '--brand-foreground', tailwind: 'bg-brand-foreground' },
      { name: 'brand-soft', var: '--brand-soft', tailwind: 'bg-[--brand-soft]' },
      { name: 'brand-strong', var: '--brand-strong', tailwind: 'bg-[--brand-strong]' },
      { name: 'brand-contrast', var: '--brand-contrast', tailwind: 'bg-[--brand-contrast]' },
    ],
  },
  {
    label: 'Semantic',
    tokens: [
      { name: 'background', var: '--background', tailwind: 'bg-background' },
      { name: 'foreground', var: '--foreground', tailwind: 'bg-foreground' },
      { name: 'card', var: '--card', tailwind: 'bg-card' },
      { name: 'popover', var: '--popover', tailwind: 'bg-popover' },
      { name: 'primary', var: '--primary', tailwind: 'bg-primary' },
      { name: 'secondary', var: '--secondary', tailwind: 'bg-secondary' },
      { name: 'muted', var: '--muted', tailwind: 'bg-muted' },
      { name: 'muted-foreground', var: '--muted-foreground', tailwind: 'bg-muted-foreground' },
      { name: 'accent', var: '--accent', tailwind: 'bg-accent' },
      { name: 'destructive', var: '--destructive', tailwind: 'bg-destructive' },
      { name: 'border', var: '--border', tailwind: 'bg-border' },
      { name: 'input', var: '--input', tailwind: 'bg-input' },
      { name: 'ring', var: '--ring', tailwind: 'bg-ring' },
      { name: 'success', var: '--success', tailwind: 'bg-success' },
      { name: 'warning', var: '--warning', tailwind: 'bg-warning' },
      { name: 'info', var: '--info', tailwind: 'bg-info' },
      { name: 'priority', var: '--priority', tailwind: 'bg-priority' },
    ],
  },
  {
    label: 'Charts',
    tokens: [
      { name: 'chart-1', var: '--chart-1', tailwind: 'bg-chart-1' },
      { name: 'chart-2', var: '--chart-2', tailwind: 'bg-chart-2' },
      { name: 'chart-3', var: '--chart-3', tailwind: 'bg-chart-3' },
      { name: 'chart-4', var: '--chart-4', tailwind: 'bg-chart-4' },
      { name: 'chart-5', var: '--chart-5', tailwind: 'bg-chart-5' },
    ],
  },
  {
    label: 'Sidebar',
    tokens: [
      { name: 'sidebar', var: '--sidebar', tailwind: 'bg-sidebar' },
      { name: 'sidebar-foreground', var: '--sidebar-foreground', tailwind: 'bg-sidebar-foreground' },
      { name: 'sidebar-primary', var: '--sidebar-primary', tailwind: 'bg-sidebar-primary' },
      { name: 'sidebar-accent', var: '--sidebar-accent', tailwind: 'bg-sidebar-accent' },
      { name: 'sidebar-border', var: '--sidebar-border', tailwind: 'bg-sidebar-border' },
      { name: 'sidebar-ring', var: '--sidebar-ring', tailwind: 'bg-sidebar-ring' },
    ],
  },
];

const FONT_TOKENS: FontToken[] = [
  { name: 'Sans', var: '--font-sans', tailwind: 'font-sans' },
  { name: 'Heading', var: '--font-heading', tailwind: 'font-heading' },
  { name: 'Serif', var: '--font-serif', tailwind: 'font-serif' },
  { name: 'Mono', var: '--font-mono', tailwind: 'font-mono' },
];

const RADIUS_TOKENS: RadiusToken[] = [
  { name: 'sm', var: '--radius-sm', tailwind: 'rounded-sm' },
  { name: 'md', var: '--radius-md', tailwind: 'rounded-md' },
  { name: 'base (--radius)', var: '--radius', tailwind: 'rounded' },
  { name: 'lg', var: '--radius-lg', tailwind: 'rounded-lg' },
  { name: 'xl', var: '--radius-xl', tailwind: 'rounded-xl' },
  { name: '2xl', var: '--radius-2xl', tailwind: 'rounded-2xl' },
  { name: '3xl', var: '--radius-3xl', tailwind: 'rounded-3xl' },
  { name: '4xl', var: '--radius-4xl', tailwind: 'rounded-4xl' },
];

function readVar(el: Element, name: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim();
}

function ColorSwatch({ token, el }: { token: ColorToken; el: Element }) {
  const value = readVar(el, token.var);
  return (
    <div className="flex items-center gap-3">
      <div
        className="size-8 shrink-0 rounded border border-border/60"
        style={{ background: `var(${token.var})` }}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-foreground">{token.name}</p>
        <p className="truncate font-mono text-[10px] text-muted-foreground">{value || token.var}</p>
      </div>
      <code className="shrink-0 rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
        {token.tailwind}
      </code>
    </div>
  );
}

export default function DesignTokensPage() {
  const [root, setRoot] = useState<Element | null>(null);

  useEffect(() => {
    setRoot(document.documentElement);
  }, []);

  const darkRef = (el: HTMLDivElement | null) => {
    // no-op — dark div reads vars relative to itself
    void el;
  };

  if (!root) return null;

  return (
    <div className="min-h-full overflow-y-auto px-6 py-8">
      <div className="mx-auto max-w-4xl space-y-12">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Design Tokens</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Live CSS custom properties resolved from <code className="rounded bg-muted px-1 font-mono text-xs">:root</code>.
          </p>
        </div>

        {/* Colors */}
        <section>
          <h2 className="mb-4 text-base font-semibold text-foreground">Colors</h2>
          <div className="space-y-8">
            {COLOR_GROUPS.map((group) => (
              <div key={group.label}>
                <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  {group.label}
                </h3>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {group.tokens.map((token) => (
                    <ColorSwatch key={token.var} token={token} el={root} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Typography */}
        <section>
          <h2 className="mb-4 text-base font-semibold text-foreground">Typography</h2>
          <div className="space-y-4">
            {FONT_TOKENS.map((token) => (
              <div key={token.var} className="flex items-center gap-4 rounded-lg border border-border/60 px-4 py-3">
                <div className="w-24 shrink-0">
                  <p className="text-xs font-medium text-foreground">{token.name}</p>
                  <code className="font-mono text-[10px] text-muted-foreground">{token.tailwind}</code>
                </div>
                <p
                  className="flex-1 text-base text-foreground"
                  style={{ fontFamily: `var(${token.var})` }}
                >
                  The quick brown fox jumps over the lazy dog
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* Radius */}
        <section>
          <h2 className="mb-4 text-base font-semibold text-foreground">Border Radius</h2>
          <div className="flex flex-wrap gap-4">
            {RADIUS_TOKENS.map((token) => {
              const value = readVar(root, token.var);
              return (
                <div key={token.var} className="flex flex-col items-center gap-2">
                  <div
                    className="size-14 border-2 border-brand bg-brand/15"
                    style={{ borderRadius: `var(${token.var})` }}
                  />
                  <div className="text-center">
                    <p className="text-xs font-medium text-foreground">{token.name}</p>
                    <p className="font-mono text-[10px] text-muted-foreground">{value || '—'}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* Dark Mode Preview */}
        <section>
          <h2 className="mb-1 text-base font-semibold text-foreground">Dark Mode Preview</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Brand swatches resolved inside a scoped <code className="rounded bg-muted px-1 font-mono text-xs">.dark</code> container.
          </p>
          <div ref={darkRef} className="dark rounded-xl border border-border/60 bg-background p-6">
            <p className="mb-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Brand — dark mode
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {COLOR_GROUPS[0]!.tokens.map((token) => (
                <div key={token.var} className="flex items-center gap-3">
                  <div
                    className="size-8 shrink-0 rounded border border-border/60"
                    style={{ background: `var(${token.var})` }}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-foreground">{token.name}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
