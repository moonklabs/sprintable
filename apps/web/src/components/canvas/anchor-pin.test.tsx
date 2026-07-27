import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AnchorPin } from './anchor-pin';

describe('AnchorPin (C2 §1-2 — open=info 채움·resolved=muted 아웃라인, 클릭 가능성에 따른 태그 전환)', () => {
  it('renders an interactive button when onClick is provided', () => {
    const markup = renderToStaticMarkup(<AnchorPin number={1} state="open" onClick={() => {}} />);
    expect(markup).toContain('<button');
    expect(markup).toContain('>1<');
  });

  it('renders a non-interactive span when onClick is omitted', () => {
    const markup = renderToStaticMarkup(<AnchorPin number={2} state="resolved" />);
    expect(markup).not.toContain('<button');
    expect(markup).toContain('<span');
  });

  it('applies the info fill class for the open state and the muted outline class for resolved', () => {
    const open = renderToStaticMarkup(<AnchorPin number={1} state="open" />);
    const resolved = renderToStaticMarkup(<AnchorPin number={1} state="resolved" />);
    expect(open).toContain('bg-info');
    expect(resolved).toContain('border-border');
    expect(resolved).not.toContain('bg-info');
  });
});
