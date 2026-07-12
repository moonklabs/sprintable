import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ArtifactVersionRail } from './artifact-version-rail';
import { MOCK_ARTIFACT, MOCK_MEMBERS, MOCK_VERSIONS } from '@/services/canvas';

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

describe('ArtifactVersionRail (C1 Lv1 — lineage, raw 편집 나열 금지·의미 단위 요약만)', () => {
  it('lists versions in descending order (newest first)', () => {
    const markup = renderToStaticMarkup(
      wrap(
        <ArtifactVersionRail
          artifact={MOCK_ARTIFACT}
          versions={MOCK_VERSIONS}
          selectedVersion={MOCK_ARTIFACT.current_version}
          onSelectVersion={vi.fn()}
          memberMap={MOCK_MEMBERS}
        />,
      ),
    );
    const v4Index = markup.indexOf('v4');
    const v3Index = markup.indexOf('v3');
    const v2Index = markup.indexOf('v2');
    expect(v4Index).toBeGreaterThan(-1);
    expect(v4Index).toBeLessThan(v3Index);
    expect(v3Index).toBeLessThan(v2Index);
  });

  it('tags the artifact.current_version entry as "지금" and the anchor_version entry as "정본"', () => {
    const markup = renderToStaticMarkup(
      wrap(
        <ArtifactVersionRail
          artifact={MOCK_ARTIFACT}
          versions={MOCK_VERSIONS}
          selectedVersion={MOCK_ARTIFACT.current_version}
          onSelectVersion={vi.fn()}
          memberMap={MOCK_MEMBERS}
        />,
      ),
    );
    expect(markup).toContain('지금');
    expect(markup).toContain('정본');
  });

  it('renders the description slot toggle but keeps it collapsed by default (no slot content leaks into initial SSR markup)', () => {
    const markup = renderToStaticMarkup(
      wrap(
        <ArtifactVersionRail
          artifact={MOCK_ARTIFACT}
          versions={MOCK_VERSIONS}
          selectedVersion={MOCK_ARTIFACT.current_version}
          onSelectVersion={vi.fn()}
          memberMap={MOCK_MEMBERS}
          descriptionSlot={<p>C2 슬롯 내용</p>}
        />,
      ),
    );
    expect(markup).toContain('description pane');
    expect(markup).not.toContain('C2 슬롯 내용');
  });
});
