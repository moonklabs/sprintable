import { parseColorGroups, parseFontTokens, parseRadiusTokens } from '@/lib/parse-design-tokens';
import { ColorSwatch } from '@/components/design-system/color-swatch';
import { FontPreview } from '@/components/design-system/font-preview';
import { RadiusSwatch } from '@/components/design-system/radius-swatch';

export default function DesignTokensPage() {
  const colorGroups = parseColorGroups();
  const fontTokens = parseFontTokens();
  const radiusTokens = parseRadiusTokens();
  const brandGroup = colorGroups.find(g => g.label === 'Brand');

  return (
    <div className="min-h-full overflow-y-auto px-6 py-8">
      <div className="mx-auto max-w-4xl space-y-12">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Design Tokens</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Live CSS custom properties resolved from{' '}
            <code className="rounded bg-muted px-1 font-mono text-xs">:root</code>.
            Tokens are auto-collected from{' '}
            <code className="rounded bg-muted px-1 font-mono text-xs">globals.css</code>.
          </p>
        </div>

        {/* Colors */}
        <section>
          <h2 className="mb-4 text-base font-semibold text-foreground">Colors</h2>
          <div className="space-y-8">
            {colorGroups.map((group) => (
              <div key={group.label}>
                <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  {group.label}
                </h3>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {group.tokens.map((token) => (
                    <ColorSwatch key={token.cssVar} token={token} />
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
            {fontTokens.map((token) => (
              <FontPreview key={token.cssVar} token={token} />
            ))}
          </div>
        </section>

        {/* Border Radius */}
        <section>
          <h2 className="mb-4 text-base font-semibold text-foreground">Border Radius</h2>
          <div className="flex flex-wrap gap-4">
            {radiusTokens.map((token) => (
              <RadiusSwatch key={token.cssVar} token={token} />
            ))}
          </div>
        </section>

        {/* Dark Mode Preview */}
        {brandGroup && (
          <section>
            <h2 className="mb-1 text-base font-semibold text-foreground">Dark Mode Preview</h2>
            <p className="mb-4 text-sm text-muted-foreground">
              Brand swatches resolved inside a scoped{' '}
              <code className="rounded bg-muted px-1 font-mono text-xs">.dark</code> container.
            </p>
            <div className="dark rounded-xl border border-border/60 bg-background p-6">
              <p className="mb-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Brand — dark mode
              </p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {brandGroup.tokens.map((token) => (
                  <div key={token.cssVar} className="flex items-center gap-3">
                    <div
                      className="size-8 shrink-0 rounded border border-border/60"
                      style={{ background: `var(${token.cssVar})` }}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium text-foreground">{token.name}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
