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
    expect(markup).toContain('설명 패널');
    expect(markup).not.toContain('C2 슬롯 내용');
  });
});

// [SID:4311 PR 3] 판 줄 작성자 — 같은 이름 서로 다른 작성자 둘이면 «· ID 앞 8자»(작성자 id마다 한 번).
describe('ArtifactVersionRail — 작성자 동명이인([SID:4311 PR 3])', () => {
  it('«송윤재» 둘 = 판마다 id 앞 8자 · 안나 = 꼬리 없음', () => {
    const members = {
      'e75ca548-1': { id: 'e75ca548-1', name: '송윤재' },
      '2fd14616-2': { id: '2fd14616-2', name: '송윤재' },
      'm-anna': { id: 'm-anna', name: '안나' },
    };
    const v = MOCK_VERSIONS[0];
    const versions = [
      { ...v, id: 'v-3', version: 3, created_by: 'e75ca548-1', summary: '' },
      { ...v, id: 'v-2', version: 2, created_by: '2fd14616-2', summary: '' },
      { ...v, id: 'v-1', version: 1, created_by: 'm-anna', summary: '' },
    ];
    const markup = renderToStaticMarkup(wrap(
      <ArtifactVersionRail artifact={{ ...MOCK_ARTIFACT, current_version: 3, anchor_version: 1 }} versions={versions} selectedVersion={3} onSelectVersion={vi.fn()} memberMap={members} />,
    ));
    const authors = [...markup.matchAll(/<p class="mt-0\.5 truncate[^"]*">([^<]*)<\/p>/g)].map((m) => m[1]);
    expect(authors).toEqual(['송윤재 · e75ca548', '송윤재 · 2fd14616', '안나']);
  });
});

