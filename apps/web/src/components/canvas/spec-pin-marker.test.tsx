import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SpecPinMarker } from './spec-pin-marker';

describe('SpecPinMarker (story 7fe16274 §4 — 코멘트 핀과 같은 레이어·아이콘으로 시각 구분)', () => {
  it('renders an interactive button with the spec (FileText) icon when onClick is provided', () => {
    const markup = renderToStaticMarkup(<SpecPinMarker onClick={() => {}} />);
    expect(markup).toContain('<button');
    expect(markup).toContain('lucide-file-text');
  });

  it('renders a non-interactive span when onClick is omitted', () => {
    const markup = renderToStaticMarkup(<SpecPinMarker />);
    expect(markup).not.toContain('<button');
    expect(markup).toContain('<span');
  });

  it('uses info(청) color, never a destructive/learning-signal red (spec §4 — 스펙은 kill/부정 신호가 아님)', () => {
    const markup = renderToStaticMarkup(<SpecPinMarker onClick={() => {}} />);
    expect(markup).toContain('bg-info');
    expect(markup).not.toContain('destructive');
  });

  it('never renders attribution props (author/time) — 감시금지, props 자체에 없음(타입 레벨 보장 회귀가드)', () => {
    const markup = renderToStaticMarkup(<SpecPinMarker onClick={() => {}} active />);
    expect(markup).not.toMatch(/created_by|createdBy|작성자/);
  });
});
