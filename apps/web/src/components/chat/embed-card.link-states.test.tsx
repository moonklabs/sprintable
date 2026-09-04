// @vitest-environment jsdom
//
// story #2302 — 채팅 임베드 칩(EntityChip)/카드(EmbedCard)가 종류마다 다르게 깨지던 것: epic
// 링크 404(AC1), task/artifact가 "담긴 곳"으로 못 감(AC3), hypothesis/evidence가 무한
// 스피너였던 것(자체발견 잠복 결함). 실제 렌더 경로(마크다운 토큰→EntityChip→클릭→
// EntityPreviewModal, chat-bubble.tsx 확認)를 그대로 태워 검증한다 — base-ui Dialog는
// document.body에 포탈되므로 assertion은 body를 본다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { EmbedCard, getEntityHref } from './embed-card';
import { translateEntityStatus } from './entity-status-labels';
// story #2614 — artifact 몸통이 이제 ArtifactThumbnail(canvas 네임스페이스 useTranslations)을
// 렌더한다.
// story 3436(묶음 1, 2026-09-04) — EmbedCard가 내부적으로 항상 마운트하는 Dialog가 이제
// DialogContent에서 useTranslations('common')을 쓴다(base-ui Dialog.Popup은 닫힌
// 상태에서도 렌더 함수 자체는 돈다) — 그래서 이제 EmbedCard를 렌더하는 모든 테스트가
// NextIntlClientProvider를 필요로 한다(예전엔 ArtifactThumbnail 경로만 필요했다).
import koMessages from '../../../messages/ko.json';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

let container: HTMLDivElement;
let root: Root;

function stubFetch(impl: (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>) {
  vi.stubGlobal('fetch', vi.fn((url: string) => impl(url)));
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.querySelectorAll('[data-slot="dialog-portal"], [role="dialog"]').forEach((el) => el.remove());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function openCard() {
  const btn = container.querySelector('button');
  await act(async () => {
    btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
}

async function flush(times = 4) {
  await act(async () => {
    for (let i = 0; i < times; i++) await Promise.resolve();
  });
}

describe('AC1 — epic 링크가 은퇴한 /epics/ 대신 실재 라우트로 간다', () => {
  it('getEntityHref("epic", id)가 /goals/{id}를 반환한다(404였던 /epics/ 아님)', () => {
    expect(getEntityHref('epic', 'e1')).toBe('/goals/e1');
  });
});

// story #2642(BE #3044) — own-href 타입(story/epic/asset)도 이제 자기 detail 응답의
// org_slug/project_slug로 직행한다(#2168 doc own-href와 동형, task/artifact/evidence
// via-parent에 이어 마지막 조각). fetch 전/실패는 기존 bare href prop 그대로(④ 원칙).
describe('story #2642 — own-href(story/epic/asset)도 크로스프로젝트 직행 URL로 착지한다', () => {
  it('story — org_slug/project_slug가 실려 오면 뷰어 현재 프로젝트 대신 그 project로 직행한다', async () => {
    stubFetch(async () => ({ ok: true, json: async () => ({ data: { org_slug: 'acme', project_slug: 'content' } }) }));
    await act(async () => {
      root.render(wrap(<EmbedCard entity_type="story" entity_id="s-cross" title="스토리 X" status={null} />));
    });
    await openCard();
    await flush();
    const link = document.querySelector('a[href="/acme/content/board?story=s-cross"]');
    expect(link).not.toBeNull();
    expect(link!.textContent).toContain('전체 보기');
    expect(document.querySelector('a[href="/board?story=s-cross"]')).toBeNull();
  });

  it('story — fetch 실패/미도착 시 기존 bare href로 우아하게 폴백한다(회귀 아님)', async () => {
    stubFetch(async () => ({ ok: false, json: async () => ({}) }));
    await act(async () => {
      root.render(wrap(<EmbedCard entity_type="story" entity_id="s-fail" title="스토리 Y" status={null} />));
    });
    await openCard();
    await flush();
    expect(document.body.textContent).toContain('대상을 찾을 수 없습니다');
  });

  it('epic — org_slug/project_slug가 실려 오면 그 project의 /goals/{id}로 직행한다', async () => {
    stubFetch(async () => ({ ok: true, json: async () => ({ data: { org_slug: 'acme', project_slug: 'content' } }) }));
    await act(async () => {
      root.render(wrap(<EmbedCard entity_type="epic" entity_id="e-cross" title="에픽 X" status={null} />));
    });
    await openCard();
    await flush();
    expect(document.querySelector('a[href="/acme/content/goals/e-cross"]')).not.toBeNull();
    expect(document.querySelector('a[href="/goals/e-cross"]')).toBeNull();
  });

  it('asset — org_slug/project_slug가 실려 오면 그 project의 storage로 직행한다', async () => {
    stubFetch(async () => ({ ok: true, json: async () => ({ data: { org_slug: 'acme', project_slug: 'content' } }) }));
    await act(async () => {
      root.render(wrap(<EmbedCard entity_type="asset" entity_id="ast-cross" title="자산 X" status={null} />));
    });
    await openCard();
    await flush();
    expect(document.querySelector('a[href="/acme/content/storage?asset=ast-cross"]')).not.toBeNull();
    expect(document.querySelector('a[href="/storage?asset=ast-cross"]')).toBeNull();
  });

  it('asset — org-level asset(project_id null→project_slug null)은 bare href로 폴백한다(④ 원칙, org-level은 project 스코프가 없다)', async () => {
    stubFetch(async () => ({ ok: true, json: async () => ({ data: { org_slug: 'acme', project_slug: null } }) }));
    await act(async () => {
      root.render(wrap(<EmbedCard entity_type="asset" entity_id="ast-org" title="자산 Y" status={null} />));
    });
    await openCard();
    await flush();
    expect(document.querySelector('a[href="/storage?asset=ast-org"]')).not.toBeNull();
  });
});

describe('AC3/AC4 — task는 부모 story로("담긴 곳으로 갑니다")', () => {
  it('task 상세 fetch가 story_id를 주면 풋터가 파랑 링크 "담긴 곳으로 갑니다"·/board?story=로 간다', async () => {
    stubFetch(async (url) => {
      expect(url).toContain('/api/tasks/');
      return { ok: true, json: async () => ({ data: { story_id: 's-parent-1' } }) };
    });
    await act(async () => {
      root.render(wrap(<EmbedCard entity_type="task" entity_id="t1" title="작업 A" status={null} />));
    });
    await openCard();
    await flush();
    const link = document.querySelector('a[href="/board?story=s-parent-1"]');
    expect(link).not.toBeNull();
    expect(link!.textContent).toContain('담긴 곳으로 갑니다');
  });

  // story #2642(BE #3044) — TaskResponse가 story_id→Story.project_id 1-hop을 이미 해소해
  // org_slug/project_slug를 직접 싣는다(FE가 추가 조회 없이 그대로 쓴다).
  it('task — org_slug/project_slug가 실려 오면 크로스프로젝트 부모 story로 직행한다(뷰어 현재 프로젝트 추측 안 거침)', async () => {
    stubFetch(async () => ({
      ok: true,
      json: async () => ({ data: { story_id: 's-parent-2', org_slug: 'acme', project_slug: 'content' } }),
    }));
    await act(async () => {
      root.render(wrap(<EmbedCard entity_type="task" entity_id="t2" title="작업 B" status={null} />));
    });
    await openCard();
    await flush();
    const link = document.querySelector('a[href="/acme/content/board?story=s-parent-2"]');
    expect(link).not.toBeNull();
    expect(link!.textContent).toContain('담긴 곳으로 갑니다');
    expect(document.querySelector('a[href="/board?story=s-parent-2"]')).toBeNull();
  });
});

// story #3208 — 위 own-href(story/epic/asset)와 별개로, artifact의 detail fetch는 이제
// preview(project_id 해소)→detail(X-Project-Id 명시) 2단 왕복이다(#2168 doc own-href와
// 동형 근본원인·처방). 이 describe 블록의 모든 stubFetch는 `/preview` 요청에 먼저 응답해야
// detail fetch까지 도달한다 — 이 헬퍼가 그 반복을 한 곳으로 모은다.
function stubArtifactPreviewThenDetail(
  detailImpl: (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>,
) {
  stubFetch(async (url) => {
    if (url.includes('/api/visual-artifacts/preview')) {
      return { ok: true, json: async () => ({ data: { projectId: 'p-current' } }) };
    }
    return detailImpl(url);
  });
}

describe('AC3/AC4 — artifact는 레코드마다 갈린다(FK 있으면 ②, 전부 없으면 ③)', () => {
  it('story_id가 있는 artifact는 "담긴 곳으로 갑니다"로 그 story로 간다', async () => {
    stubArtifactPreviewThenDetail(async () => ({
      ok: true,
      json: async () => ({ data: { story_id: 's-1', epic_id: null, doc_id: null } }),
    }));
    await act(async () => {
      root.render(wrap(<EmbedCard entity_type="artifact" entity_id="a1" title="목업 A" status={null} />));
    });
    await openCard();
    await flush();
    const link = document.querySelector('a[href="/board?story=s-1"]');
    expect(link).not.toBeNull();
    expect(link!.textContent).toContain('담긴 곳으로 갑니다');
  });

  it('story #3208 핵심 처방 — 뷰어가 다른 project를 보던 중이어도 preview가 해소한 project_id를 detail fetch에 X-Project-Id로 명시 실어 보낸다(«현재 project»로 스코프되지 않음)', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
      calls.push({ url, headers });
      if (url.includes('/api/visual-artifacts/preview')) {
        return { ok: true, json: async () => ({ data: { projectId: 'p-owning' } }) };
      }
      return { ok: true, json: async () => ({ data: { story_id: null, epic_id: null, doc_id: null } }) };
    }));
    await act(async () => {
      root.render(wrap(<EmbedCard entity_type="artifact" entity_id="a-cross" title="크로스 목업" status={null} />));
    });
    await openCard();
    await flush();
    const detailCall = calls.find((c) => c.url === '/api/visual-artifacts/a-cross');
    expect(detailCall).toBeDefined();
    // Headers는 이름을 소문자로 정규화한다.
    expect(detailCall!.headers['x-project-id']).toBe('p-owning');
  });

  it('epic_id만 있으면 그 epic(/goals/)으로 간다', async () => {
    stubArtifactPreviewThenDetail(async () => ({
      ok: true,
      json: async () => ({ data: { story_id: null, epic_id: 'e-9', doc_id: null } }),
    }));
    await act(async () => {
      root.render(wrap(<EmbedCard entity_type="artifact" entity_id="a2" title="목업 B" status={null} />));
    });
    await openCard();
    await flush();
    expect(document.querySelector('a[href="/goals/e-9"]')).not.toBeNull();
  });

  // story #2642(BE #3044) — ArtifactResponse는 artifact 자기 행의 org_id/project_id를
  // 직접 싣는다(부모 hop 불필요) — story_id/epic_id 분기 둘 다 이 값을 그대로 쓴다.
  it('story_id + org_slug/project_slug가 있는 artifact는 크로스프로젝트 부모 story로 직행한다', async () => {
    stubArtifactPreviewThenDetail(async () => ({
      ok: true,
      json: async () => ({ data: { story_id: 's-1', epic_id: null, doc_id: null, org_slug: 'acme', project_slug: 'content' } }),
    }));
    await act(async () => {
      root.render(wrap(<EmbedCard entity_type="artifact" entity_id="a6" title="목업 E" status={null} />));
    });
    await openCard();
    await flush();
    expect(document.querySelector('a[href="/acme/content/board?story=s-1"]')).not.toBeNull();
    expect(document.querySelector('a[href="/board?story=s-1"]')).toBeNull();
  });

  it('epic_id + org_slug/project_slug가 있는 artifact는 크로스프로젝트 부모 epic으로 직행한다', async () => {
    stubArtifactPreviewThenDetail(async () => ({
      ok: true,
      json: async () => ({ data: { story_id: null, epic_id: 'e-9', doc_id: null, org_slug: 'acme', project_slug: 'content' } }),
    }));
    await act(async () => {
      root.render(wrap(<EmbedCard entity_type="artifact" entity_id="a7" title="목업 F" status={null} />));
    });
    await openCard();
    await flush();
    expect(document.querySelector('a[href="/acme/content/goals/e-9"]')).not.toBeNull();
    expect(document.querySelector('a[href="/goals/e-9"]')).toBeNull();
  });

  // story #2642(PO 08-14, «FE 단독 가능» 조각) — doc_id가 있는 artifact도 이제 #2168(doc
  // own-href)과 동형으로 그 doc 자신이 속한 project로 직행한다. 이전엔 project 무관 bare
  // `/docs?id=`(그나마도 [ws]/[proj]/docs 라이브 라우트가 `?id=`를 안 읽어 죽은 링크였다 —
  // 이 처방이 그 사각도 같이 없앤다).
  it('doc_id가 있는 artifact — 그 doc이 속한 project로 직행한다(#2168 재사용, 새 BE 없음)', async () => {
    stubFetch(async (url) => {
      if (url.includes('/api/visual-artifacts/preview')) {
        return { ok: true, json: async () => ({ data: { projectId: 'p-current' } }) };
      }
      if (url.includes('/api/visual-artifacts/')) {
        if (url.includes('/exports')) return { ok: true, json: async () => ({ data: [] }) };
        if (url.includes('/versions/')) return { ok: false, json: async () => ({}) };
        return { ok: true, json: async () => ({ data: { story_id: null, epic_id: null, doc_id: 'doc-9' } }) };
      }
      if (url.includes('/api/docs/preview')) {
        expect(url).toContain('doc-9');
        return { ok: true, json: async () => ({ data: { slug: 'other-doc', orgSlug: 'acme', projectSlug: 'content', projectId: 'p-9' } }) };
      }
      return { ok: false, json: async () => ({}) };
    });
    await act(async () => {
      root.render(wrap(<EmbedCard entity_type="artifact" entity_id="a4" title="목업 C" status={null} />));
    });
    await openCard();
    await flush(8);
    const link = document.querySelector('a[href="/acme/content/docs/other-doc/view"]');
    expect(link).not.toBeNull();
    expect(link!.textContent).toContain('담긴 곳으로 갑니다');
    // 옛 project-무관 bare 링크가 더는 안 남아야 한다(진짜로 직행 링크로 교체됐는지 확認).
    expect(document.querySelector('a[href="/docs?id=doc-9"]')).toBeNull();
  });

  it('doc_id가 있는 artifact — doc preview 조회 실패 시 기존 bare `/docs?id=`로 우아하게 폴백한다(회귀 아님, ④ 원칙)', async () => {
    stubFetch(async (url) => {
      if (url.includes('/api/visual-artifacts/preview')) {
        return { ok: true, json: async () => ({ data: { projectId: 'p-current' } }) };
      }
      if (url.includes('/api/visual-artifacts/')) {
        if (url.includes('/exports')) return { ok: true, json: async () => ({ data: [] }) };
        if (url.includes('/versions/')) return { ok: false, json: async () => ({}) };
        return { ok: true, json: async () => ({ data: { story_id: null, epic_id: null, doc_id: 'doc-10' } }) };
      }
      return { ok: false, json: async () => ({}) }; // /api/docs/preview 도 이걸로 실패.
    });
    await act(async () => {
      root.render(wrap(<EmbedCard entity_type="artifact" entity_id="a5" title="목업 D" status={null} />));
    });
    await openCard();
    await flush(8);
    const link = document.querySelector('a[href="/docs?id=doc-10"]');
    expect(link).not.toBeNull();
    expect(link!.textContent).toContain('담긴 곳으로 갑니다');
  });

  it('전부 null(독립 artifact)이면 회색·행동0 "열 수 있는 화면이 없습니다"(거짓 링크 금지)', async () => {
    stubArtifactPreviewThenDetail(async () => ({
      ok: true,
      json: async () => ({ data: { story_id: null, epic_id: null, doc_id: null } }),
    }));
    await act(async () => {
      root.render(wrap(<EmbedCard entity_type="artifact" entity_id="a3" title="독립 목업" status={null} />));
    });
    await openCard();
    await flush();
    // 링크가 없어야 한다 — 있으면 "갈 수 있다고 말하고 배신하는"(유나 판정) 거짓.
    expect(document.querySelectorAll('a[href^="/goals/"], a[href^="/board?story="], a[href^="/docs?id="]').length).toBe(0);
    expect(document.body.textContent).toContain('열 수 있는 화면이 없습니다');
  });
});

describe('story #2614 — hypothesis는 풋터(담긴 곳)는 여전히 없지만(다대다, ③ 고정 무변경) 몸통은 이제 fetch해 statement를 보인다', () => {
  it('hypothesis는 fetch해 statement를 몸통에 보이면서도 풋터는 "열 수 있는 화면이 없습니다"를 유지한다(거짓 링크 금지는 그대로)', async () => {
    stubFetch(async (url) => {
      expect(url).toContain('/api/hypotheses/');
      return { ok: true, json: async () => ({ data: { statement: '이 가설은 검증되면 전환율이 오른다', status: 'proposed' } }) };
    });
    await act(async () => {
      root.render(wrap(<EmbedCard entity_type="hypothesis" entity_id="h1" title="가설 A" status={null} />));
    });
    await openCard();
    await flush();
    expect(document.body.textContent).toContain('이 가설은 검증되면 전환율이 오른다');
    expect(document.body.textContent).not.toContain('이 엔티티는 별도 미리보기가 없습니다');
    // AC3/AC4 — 다대다라 단일 부모를 못 고르는 사실은 안 바뀌었다: 풋터는 여전히 "갈 곳 없음".
    expect(document.querySelectorAll('a[href^="/goals/"], a[href^="/board?story="], a[href^="/docs?id="]').length).toBe(0);
    expect(document.body.textContent).toContain('열 수 있는 화면이 없습니다');
  });

  it('hypothesis 조회가 실패하면(대상 사라짐) 여전히 "대상이 없습니다"로 정직하게 갈린다(무한 스피너였던 자체발견 회귀 재확認)', async () => {
    stubFetch(async () => ({ ok: false, json: async () => ({}) }));
    await act(async () => {
      root.render(wrap(<EmbedCard entity_type="hypothesis" entity_id="h-gone" title="사라진 가설" status={null} />));
    });
    await openCard();
    await flush();
    expect(document.body.textContent).not.toContain('불러오는 중');
    expect(document.body.textContent).toContain('대상을 찾을 수 없습니다');
  });
});

describe('story #2614 AC1/AC3 — artifact(부모 없는 독립 목업)는 몸통에서 실물이 보인다(회귀: "미리보기가 없습니다"가 지원 타입에서 뜨면 안 됨)', () => {
  it('부모(story/epic/doc) 전부 null인 artifact도 썸네일이 렌더돼 "이 엔티티는 별도 미리보기가 없습니다"가 안 뜬다', async () => {
    // ArtifactThumbnail 자신도 exports/version-detail을 따로 fetch한다(둘 다 /api/visual-artifacts/
    // 하위 경로) — URL별로 분기해, exports는 빈 배열(PNG 없음)·version-detail은 404(간단히
    // placeholder 경로로 떨어뜨림, 이 테스트의 관심사는 "썸네일 요소 자체가 뜨는가"이지 실 렌더
    // 내용물이 아니다)로 응답해 ArtifactThumbnail이 안전하게 placeholder로 정착하게 한다.
    stubFetch(async (url) => {
      expect(url).toContain('/api/visual-artifacts/');
      // story #3208 — EntityPreviewModal의 detail fetch·EmbedCard 자신의 썸네일 fetch 둘 다
      // 이제 preview(project_id 해소)를 먼저 부른다(#2168 doc own-href와 동형).
      if (url.includes('/preview')) return { ok: true, json: async () => ({ data: { projectId: 'p-current' } }) };
      if (url.includes('/exports')) return { ok: true, json: async () => ({ data: [] }) };
      if (url.includes('/versions/')) return { ok: false, json: async () => ({}) };
      return {
        ok: true,
        json: async () => ({
          data: { story_id: null, epic_id: null, doc_id: null, latest_version_number: 1, anchor_version: null },
        }),
      };
    });
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <EmbedCard entity_type="artifact" entity_id="91eaf539" title="mockup" status={null} />
        </NextIntlClientProvider>,
      );
    });
    await openCard();
    await flush();
    // AC3 회귀 가드 — 지원 타입(artifact)에서 "미리보기 없음" 문구가 뜨면 빨간불.
    expect(document.body.textContent).not.toContain('이 엔티티는 별도 미리보기가 없습니다');
    expect(document.querySelector('[data-artifact-thumbnail]')).not.toBeNull();
    // 부모가 없다는 사실 자체는 안 바뀌었다 — 풋터는 여전히 "갈 곳 없음"(거짓 링크 금지 유지).
    expect(document.body.textContent).toContain('열 수 있는 화면이 없습니다');
  });
});

// story #2780 — sprint/task가 RICH_PREVIEW_TYPES에 편입됐다(§3/페드루 판정: "있으면 열고
// 없으면 안 연다" — TaskResponse/SprintResponse 실측상 title·status가 있어 편입). 이 가드의
// 취지("미리보기 없음" 문구는 실제로 보여줄 내용이 없을 때만 뜬다, #2614 AC3)는 안 바뀌었다 —
// 새 전제: RICH 타입이어도 detail에 필요한 필드(title)가 없으면 여전히 이 문구가 뜬다(카디르
// QA 발견 — 편입 직후엔 이 문구 대신 완전 공백이 떴었다, embed-card.tsx richContent 가드로 수정).
describe('story #2780 — "미리보기 없음" 문구는 "실제로 보여줄 내용이 없을 때" 정직하게 뜬다(미지원 타입이든, RICH 타입인데 필드가 없든)', () => {
  it('sprint(#2780로 RICH 편입) — title 없는 옛 응답 모양(미백필 등)이면 몸통이 공백 아닌 "미리보기 없음"+bare href로 우아하게 폴백한다', async () => {
    stubFetch(async () => ({ ok: true, json: async () => ({ data: {} }) }));
    await act(async () => {
      root.render(wrap(<EmbedCard entity_type="sprint" entity_id="sp1" title="스프린트 3" status={null} />));
    });
    await openCard();
    await flush();
    expect(document.body.textContent).toContain('이 엔티티는 별도 미리보기가 없습니다');
    expect(document.querySelector('a[href="/sprints?id=sp1"]')).not.toBeNull();
  });

  it('sprint(#2780) — title·status·기간이 실려 오면 RICH 몸통(뱃지)이 렌더되고 "미리보기 없음"은 안 뜬다', async () => {
    stubFetch(async () => ({
      ok: true,
      json: async () => ({ data: { title: '스프린트 5', status: 'active', start_date: '2026-08-01', end_date: '2026-08-14' } }),
    }));
    await act(async () => {
      root.render(wrap(<EmbedCard entity_type="sprint" entity_id="sp3" title="스프린트 5" status={null} />));
    });
    await openCard();
    await flush();
    expect(document.body.textContent).not.toContain('이 엔티티는 별도 미리보기가 없습니다');
    expect(document.body.textContent).toContain('2026-08-01 ~ 2026-08-14');
  });

  it('sprint — fetch 자체가 실패하면(대상 사라짐 등) "대상을 찾을 수 없습니다"로 정직하게 갈린다(#2642로 sprint도 fetch-eligible 승격 — 이전엔 이 갈래가 아예 없었다)', async () => {
    stubFetch(async () => ({ ok: false, json: async () => ({}) }));
    await act(async () => {
      root.render(wrap(<EmbedCard entity_type="sprint" entity_id="sp-gone" title="사라진 스프린트" status={null} />));
    });
    await openCard();
    await flush();
    expect(document.body.textContent).toContain('대상을 찾을 수 없습니다');
  });

  it('sprint — org_slug/project_slug가 도착하면 크로스프로젝트 직행 URL로 바뀐다(#2642)', async () => {
    stubFetch(async (url) => {
      expect(url).toContain('/api/sprints/');
      return { ok: true, json: async () => ({ data: { org_slug: 'acme', project_slug: 'content' } }) };
    });
    await act(async () => {
      root.render(wrap(<EmbedCard entity_type="sprint" entity_id="sp2" title="스프린트 4" status={null} />));
    });
    await openCard();
    await flush();
    expect(document.querySelector('a[href="/acme/content/sprints?id=sp2"]')).not.toBeNull();
    expect(document.querySelector('a[href="/sprints?id=sp2"]')).toBeNull();
  });
});

describe('AC3/AC4 — evidence는 부모 story로("담긴 곳으로 갑니다", story #2314 승격)', () => {
  it('story #2314(2026-07-29): GET /api/v2/evidence/{id} 개통 前엔 임시 ③이었으나, 이제 fetch해서 ②로 판정한다 — resolved_story_id를 BE가 이미 한 번에 해소해 준다(task처럼 2단 조인 불필요)', async () => {
    stubFetch(async (url) => {
      expect(url).toContain('/api/evidence/');
      return { ok: true, json: async () => ({ data: { resolved_story_id: 's-parent-2' } }) };
    });
    await act(async () => {
      root.render(wrap(<EmbedCard entity_type="evidence" entity_id="ev1" title="증거 A" status={null} />));
    });
    await openCard();
    await flush();
    const link = document.querySelector('a[href="/board?story=s-parent-2"]');
    expect(link).not.toBeNull();
    expect(link!.textContent).toContain('담긴 곳으로 갑니다');
  });

  it('resolved_story_id가 없으면(예: 부모 task가 사라짐) 회색·행동0 "열 수 있는 화면이 없습니다"(거짓 링크 금지)', async () => {
    stubFetch(async () => ({ ok: true, json: async () => ({ data: { resolved_story_id: null } }) }));
    await act(async () => {
      root.render(wrap(<EmbedCard entity_type="evidence" entity_id="ev2" title="증거 B" status={null} />));
    });
    await openCard();
    await flush();
    expect(document.querySelectorAll('a[href^="/board?story="]').length).toBe(0);
    expect(document.body.textContent).toContain('열 수 있는 화면이 없습니다');
  });

  // story #2642(BE #3044) — EvidenceResponse가 resolve 과정에서 이미 계산해 둔 project_id로
  // org_slug/project_slug도 같이 싣는다(추가 join 없음).
  it('evidence — org_slug/project_slug가 실려 오면 크로스프로젝트 부모 story로 직행한다', async () => {
    stubFetch(async () => ({
      ok: true,
      json: async () => ({ data: { resolved_story_id: 's-parent-3', org_slug: 'acme', project_slug: 'content' } }),
    }));
    await act(async () => {
      root.render(wrap(<EmbedCard entity_type="evidence" entity_id="ev3" title="증거 C" status={null} />));
    });
    await openCard();
    await flush();
    const link = document.querySelector('a[href="/acme/content/board?story=s-parent-3"]');
    expect(link).not.toBeNull();
    expect(link!.textContent).toContain('담긴 곳으로 갑니다');
    expect(document.querySelector('a[href="/board?story=s-parent-3"]')).toBeNull();
  });
});

describe('AC4 — 조회 실패(대상 사라짐)는 "대상이 없습니다"로 다른 문구·회색', () => {
  it('task 상세 fetch가 실패하면 ㉠ "대상이 없습니다"를 보인다(㉡-b "열 수 있는 화면이 없습니다"와 문구가 다르다)', async () => {
    stubFetch(async () => ({ ok: false, json: async () => ({}) }));
    await act(async () => {
      root.render(wrap(<EmbedCard entity_type="task" entity_id="t-gone" title="사라진 작업" status={null} />));
    });
    await openCard();
    await flush();
    expect(document.body.textContent).toContain('대상이 없습니다');
    expect(document.body.textContent).not.toContain('열 수 있는 화면이 없습니다');
  });
});

describe('story #2262 AC2(2026-08-08, 쉬운 절반) — 모달이 자기 fetch한 detail.status를 물린다', () => {
  // entity_type="task"를 쓴다 — EntityDetail이 story/epic에는 자기 status 뱃지(MdBadge)를
  // 이미 body에 그리지만 task엔 그 분기가 없어(embed-card.tsx EntityDetail), 헤더 배선만
  // 값으로 깨끗하게 격리해 잰다.
  // story #2522 — resolvedStatus는 이제 translateEntityStatus를 반드시 거친다(원시값 노출
  // 금지). 그래서 아래 두 테스트는 원시값 문자열이 아니라 「번역된」 사람 말을 검증한다.
  it('status prop이 null(EntityChip 호출부처럼 status를 모름)이어도 fetch한 detail.status를 번역해 헤더 뱃지로 보인다', async () => {
    stubFetch(async (url) => {
      expect(url).toContain('/api/tasks/');
      return { ok: true, json: async () => ({ data: { status: 'in-progress', story_id: 's-parent' } }) };
    });
    await act(async () => {
      root.render(wrap(<EmbedCard entity_type="task" entity_id="t1" title="작업 A" status={null} />));
    });
    await openCard();
    await flush();
    expect(document.body.textContent).toContain('진행 중');
    expect(document.body.textContent).not.toContain('in-progress');
  });

  it('status prop이 이미 실려 있으면(EmbedCard 자신의 write-response 경로) 그 값을 번역해 헤더가 우선한다', async () => {
    stubFetch(async () => ({ ok: true, json: async () => ({ data: { status: 'done', story_id: 's-parent' } }) }));
    await act(async () => {
      root.render(wrap(<EmbedCard entity_type="task" entity_id="t1" title="작업 A" status="todo" />));
    });
    await openCard();
    await flush();
    // 헤더는 카드 자체에도 뜨고(inner) 모달에도 뜬다 — 둘 다 prop 값(todo→"할 일")이어야
    // 하고, fetch가 준 "done"(→"완료")은 헤더 어디에도 안 나타나야 한다(task는 EntityDetail
    // 자기 status 표시가 없다).
    const label = translateEntityStatus('task', 'todo')!;
    const labelCount = (document.body.textContent!.match(new RegExp(label, 'g')) ?? []).length;
    expect(labelCount).toBeGreaterThanOrEqual(2);
    expect(document.body.textContent).not.toContain(translateEntityStatus('task', 'done'));
  });

  it('fetch가 실패해도(대상 없음) status 뱃지를 지어내지 않는다 — 모르는 것을 단정하지 않는다', async () => {
    stubFetch(async () => ({ ok: false, json: async () => ({}) }));
    await act(async () => {
      root.render(wrap(<EmbedCard entity_type="task" entity_id="t-gone" title="사라진 작업" status={null} />));
    });
    await openCard();
    await flush();
    expect(document.body.textContent).toContain('대상이 없습니다');
  });
});

// story #2522 — EntityDetail(모달 본문)의 story/epic 자기 status 뱃지도 「클래스 전체」에
// 포함된다(위 describe는 task 헤더 배선만 격리해 쟀다 — task는 EntityDetail 자기 status
// 뱃지 분기가 아예 없다). 여기서 story·epic 본문 뱃지를 직접 잰다.
describe('story #2522 — EntityDetail(모달 본문) story·epic 자기 status 뱃지도 원시값 노출 금지', () => {
  it('story 본문 status 뱃지가 번역된 말로 뜬다(원시값 in-review 안 남음)', async () => {
    stubFetch(async () => ({ ok: true, json: async () => ({ data: { status: 'in-review', description: '설명' } }) }));
    await act(async () => {
      root.render(wrap(<EmbedCard entity_type="story" entity_id="s1" title="스토리 A" status={null} />));
    });
    await openCard();
    await flush();
    expect(document.body.textContent).toContain('검토 중');
    expect(document.body.textContent).not.toContain('in-review');
  });

  it('epic 본문 status 뱃지가 번역된 말로 뜬다(원시값 active 자체는 겹치므로 archived로 격리해 확認)', async () => {
    stubFetch(async () => ({ ok: true, json: async () => ({ data: { status: 'archived', objective: '목표' } }) }));
    await act(async () => {
      root.render(wrap(<EmbedCard entity_type="epic" entity_id="e1" title="에픽 A" status={null} />));
    });
    await openCard();
    await flush();
    expect(document.body.textContent).toContain('보관');
    expect(document.body.textContent).not.toContain('archived');
  });

  // AC — 「미매핑 status는 빈칸(지어내지 않음)」. 맵에 없는 신규 status가 서빙돼도 원시값이
  // 새지 않는다는 fail-safe 계약을 값으로 고정한다.
  it('맵에 없는(미매핑) status는 원시값도 새 라벨도 안 뜬다 — 빈칸', async () => {
    stubFetch(async () => ({ ok: true, json: async () => ({ data: { status: 'some-brand-new-status', description: '설명' } }) }));
    await act(async () => {
      root.render(wrap(<EmbedCard entity_type="story" entity_id="s2" title="스토리 B" status={null} />));
    });
    await openCard();
    await flush();
    expect(document.body.textContent).not.toContain('some-brand-new-status');
  });
});
