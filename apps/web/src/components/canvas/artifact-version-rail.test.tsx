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
    // 판 줄 작성자 = RowName(이름 · 꼬리 부품) — 이름 + 꼬리 글자를 이어 읽는다.
    const authors = [...markup.matchAll(/data-row-name-part="name"[^>]*>([^<]*)<\/span>(?:<span data-row-name-part="tail"[^>]*>([^<]*)<\/span>)?/g)].map((m) => m[1] + (m[2] ?? ''));
    expect(authors).toEqual(['송윤재 · e75ca548', '송윤재 · 2fd14616', '안나']);
  });
});

// [SID:4311 PR 3 · 유나 1440 실측] 판 줄 «이름 · 꼬리 · 요약» — 잘림 순서 요약 → 이름 · 꼬리는 안 잘림. 줄 전체 truncate 없음 · 요약은 큰 줄어듦 가중치.
describe('ArtifactVersionRail — 판 줄 잘림 순서([SID:4311 PR 3])', () => {
  it('긴 이름 + 꼬리 + 긴 요약: 줄은 flex(한 덩어리 truncate 아님) · 요약 min-w-0 truncate shrink-[999] · 이름만 truncate · 꼬리 shrink-0 온전', () => {
    const long = '아주긴이름의구성원님이름이더길어요';
    const members = { 'e75ca548-1': { id: 'e75ca548-1', name: long }, '2fd14616-2': { id: '2fd14616-2', name: long } };
    const v = MOCK_VERSIONS[0];
    const versions = [
      { ...v, id: 'v-2', version: 2, created_by: 'e75ca548-1', summary: '레이아웃 전면 개편과 색 토큰 정리 그리고 문구 다듬기' },
      { ...v, id: 'v-1', version: 1, created_by: '2fd14616-2', summary: '' },
    ];
    const markup = renderToStaticMarkup(wrap(
      <ArtifactVersionRail artifact={{ ...MOCK_ARTIFACT, current_version: 2, anchor_version: 1 }} versions={versions} selectedVersion={2} onSelectVersion={vi.fn()} memberMap={members} />,
    ));
    const line = /<p class="(mt-0\.5[^"]*)">(.*?)<\/p>/.exec(markup)!;
    expect(line[1].split(' ')).toEqual(expect.arrayContaining(['flex', 'min-w-0']));
    expect(line[1].split(' ')).not.toContain('truncate');
    expect(line[2]).toMatch(/data-row-name-part="name" class="min-w-0 truncate">아주긴이름의구성원님이름이더길어요<\/span>/);
    expect(line[2]).toMatch(/data-row-name-part="tail" class="shrink-0 whitespace-pre"> · e75ca548<\/span>/);
    const summary = /<span class="([^"]*)">\u00a0· 레이아웃/.exec(line[2]);
    expect(summary, '요약은 따로 잘리는 칸').not.toBeNull();
    expect(summary![1].split(' ')).toEqual(expect.arrayContaining(['min-w-0', 'shrink-[999]', 'truncate']));
  });
});

