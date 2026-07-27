import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ComponentPalette } from './component-palette';
import { PALETTE_TYPES } from '@/services/canvas-nodes';

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

describe('ComponentPalette (C3 §2 — 부품 팔레트, 클릭 추가 MVP)', () => {
  it('renders one button per palette type', () => {
    const markup = renderToStaticMarkup(wrap(<ComponentPalette onAdd={vi.fn()} />));
    for (const type of PALETTE_TYPES) expect(markup).toContain(`>${type}<`);
  });

  it('disables every button when disabled=true (e.g. no container selected to add into)', () => {
    const markup = renderToStaticMarkup(wrap(<ComponentPalette onAdd={vi.fn()} disabled />));
    expect(markup).toContain('disabled=""');
  });

  it('leaves buttons enabled by default', () => {
    const markup = renderToStaticMarkup(wrap(<ComponentPalette onAdd={vi.fn()} />));
    expect(markup).not.toContain('disabled=""');
  });
});
