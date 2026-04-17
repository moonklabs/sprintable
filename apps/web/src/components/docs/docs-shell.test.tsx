import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DocsShell } from './docs-shell';

describe('DocsShell', () => {
  it('uses a mobile drawer and desktop split layout for the docs sidebar', () => {
    const markup = renderToStaticMarkup(
      <DocsShell sidebar={<div>sidebar</div>} mobileSidebarOpen>
        <div>content</div>
      </DocsShell>,
    );

    expect(markup).toContain('md:grid-cols-[280px_minmax(0,1fr)]');
    expect(markup).toContain('md:block');
    expect(markup).toContain('fixed inset-0 z-50 md:hidden');
    expect(markup).toContain('Close docs sidebar');
  });
});
