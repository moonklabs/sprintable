// @vitest-environment jsdom
// (story #4343 — 레일 모양 테스트가 DOMParser를 쓴다 · 나머지는 renderToStaticMarkup 그대로)
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
  it('긴 이름 + 꼬리 + 긴 요약: 줄은 flex(한 덩어리 truncate 아님) · 요약 min-w-0 flex-1 truncate(바탕 0) · 이름만 truncate · 꼬리 shrink-0 온전', () => {
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
    expect(summary![1].split(' ')).toEqual(expect.arrayContaining(['min-w-0', 'flex-1', 'truncate']));
    // 예전 shrink-[999](곁글 바탕 = 글자 폭)는 곁글이 보이는 동안에도 이름을 0.05~0.14px 줄여 말줄임이 글자 하나를 먹었다(유나 390).
    expect(summary![1].split(' ').filter((c) => /^shrink-/.test(c))).toEqual([]);
    expect(line[2]).toMatch(/data-row-name="" class="flex min-w-0 max-w-full items-baseline"/);
  });
});

// story #4343(유나 실측 · PO 11:22Z) — 레일 줄이 버전 수만큼 서자 sm 이상에서 레일(8버전 517px)이 카드 줄 높이를 정해 스테이지(375px) 아래가 ~140px 비었다.
// 이제 sm 이상은 스테이지가 줄 높이를 정하고 버전 목록만 안에서 스크롤 · 머리글 · 설명 패널은 목록 밖 고정 · 390(쌓임)은 상한 없음.
// jsdom은 배치를 안 해서 모양(클래스)만 못박는다 — 실제 높이 · 스크롤은 실브라우저 판(PR 댓글)이 긴 목록 양성 대조로 잰다.
describe('ArtifactVersionRail — sm 이상은 스테이지가 줄 높이 · 목록만 스크롤(story #4343)', () => {
  it('레일 = sm:h-0 sm:min-h-full 세로 flex · 목록 = sm에서만 min-h-0 flex-1 overflow-y-auto + scrollbar-visible · 머리글 · 설명 토글은 목록 밖 · 모바일 상한 0', () => {
    const v = MOCK_VERSIONS[0];
    const versions = Array.from({ length: 9 }, (_, i) => ({ ...v, id: `v-${9 - i}`, version: 9 - i }));
    const markup = renderToStaticMarkup(wrap(
      <ArtifactVersionRail artifact={{ ...MOCK_ARTIFACT, current_version: 9, anchor_version: 1 }} versions={versions} selectedVersion={9} onSelectVersion={vi.fn()} memberMap={MOCK_MEMBERS} />,
    ));
    const doc = new DOMParser().parseFromString(markup, 'text/html');
    const rail = doc.body.firstElementChild as HTMLElement;
    expect(rail.className.split(' ')).toEqual(expect.arrayContaining(['flex', 'flex-col', 'sm:h-0', 'sm:min-h-full']));
    const list = rail.querySelector('ul[data-version-list]') as HTMLElement;
    const cls = list.className.split(' ');
    expect(cls).toEqual(expect.arrayContaining(['sm:min-h-0', 'sm:flex-1', 'sm:overflow-y-auto', 'scrollbar-visible', 'focus-inset'])); // focus-inset: 스크롤 상자가 초점 링을 자르지 않게(#2062)
    // 390(쌓임) 상한 없음 — 모바일(접두어 없는) 높이 상한 · 스크롤 0
    expect(cls.filter((c) => /^(max-h-|h-|overflow-)/.test(c))).toEqual([]);
    expect(list.querySelectorAll(':scope > li')).toHaveLength(9);
    // 머리글 · 설명 토글은 목록 밖(레일 직속) · 줄어들지 않음
    const header = rail.firstElementChild as HTMLElement;
    expect(header.tagName).toBe('P');
    expect(header.className.split(' ')).toContain('shrink-0');
    const toggle = rail.querySelector(':scope > button') as HTMLElement;
    expect(toggle.className.split(' ')).toContain('shrink-0');
    expect(list.contains(toggle)).toBe(false);
  });
});
