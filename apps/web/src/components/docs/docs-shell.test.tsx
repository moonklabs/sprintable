import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DocsShell } from './docs-shell';

describe('DocsShell', () => {
  it('renders a flat 2-panel desktop layout with border-r divider and no rounded outer card', () => {
    const markup = renderToStaticMarkup(
      <DocsShell sidebar={<div>sidebar</div>}>
        <div>content</div>
      </DocsShell>,
    );

    expect(markup).toContain('w-[300px]');
    expect(markup).toContain('border-r');
    expect(markup).not.toContain('rounded-2xl');
    expect(markup).not.toContain('GlassPanel');
  });
});
