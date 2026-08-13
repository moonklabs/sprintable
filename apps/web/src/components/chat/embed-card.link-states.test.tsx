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
// 렌더하므로, 그 경로를 태우는 테스트만 NextIntlClientProvider로 감싼다(다른 기존 테스트는
// i18n을 안 타 무변경).
import koMessages from '../../../messages/ko.json';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

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

describe('AC3/AC4 — task는 부모 story로("담긴 곳으로 갑니다")', () => {
  it('task 상세 fetch가 story_id를 주면 풋터가 파랑 링크 "담긴 곳으로 갑니다"·/board?story=로 간다', async () => {
    stubFetch(async (url) => {
      expect(url).toContain('/api/tasks/');
      return { ok: true, json: async () => ({ data: { story_id: 's-parent-1' } }) };
    });
    await act(async () => {
      root.render(<EmbedCard entity_type="task" entity_id="t1" title="작업 A" status={null} />);
    });
    await openCard();
    await flush();
    const link = document.querySelector('a[href="/board?story=s-parent-1"]');
    expect(link).not.toBeNull();
    expect(link!.textContent).toContain('담긴 곳으로 갑니다');
  });
});

describe('AC3/AC4 — artifact는 레코드마다 갈린다(FK 있으면 ②, 전부 없으면 ③)', () => {
  it('story_id가 있는 artifact는 "담긴 곳으로 갑니다"로 그 story로 간다', async () => {
    stubFetch(async () => ({
      ok: true,
      json: async () => ({ data: { story_id: 's-1', epic_id: null, doc_id: null } }),
    }));
    await act(async () => {
      root.render(<EmbedCard entity_type="artifact" entity_id="a1" title="목업 A" status={null} />);
    });
    await openCard();
    await flush();
    const link = document.querySelector('a[href="/board?story=s-1"]');
    expect(link).not.toBeNull();
    expect(link!.textContent).toContain('담긴 곳으로 갑니다');
  });

  it('epic_id만 있으면 그 epic(/goals/)으로 간다', async () => {
    stubFetch(async () => ({
      ok: true,
      json: async () => ({ data: { story_id: null, epic_id: 'e-9', doc_id: null } }),
    }));
    await act(async () => {
      root.render(<EmbedCard entity_type="artifact" entity_id="a2" title="목업 B" status={null} />);
    });
    await openCard();
    await flush();
    expect(document.querySelector('a[href="/goals/e-9"]')).not.toBeNull();
  });

  it('전부 null(독립 artifact)이면 회색·행동0 "열 수 있는 화면이 없습니다"(거짓 링크 금지)', async () => {
    stubFetch(async () => ({
      ok: true,
      json: async () => ({ data: { story_id: null, epic_id: null, doc_id: null } }),
    }));
    await act(async () => {
      root.render(<EmbedCard entity_type="artifact" entity_id="a3" title="독립 목업" status={null} />);
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
      root.render(<EmbedCard entity_type="hypothesis" entity_id="h1" title="가설 A" status={null} />);
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
      root.render(<EmbedCard entity_type="hypothesis" entity_id="h-gone" title="사라진 가설" status={null} />);
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

// story #2614 AC3 — "이 엔티티는 별도 미리보기가 없습니다" 문구는 지원 타입(RICH_PREVIEW_TYPES:
// story/epic/doc/artifact/hypothesis)에서 뜨면 회귀다. sprint/task/evidence/asset은 의도적으로
// 이 Set 밖(sprint=own-href로 이미 열림+몸통에 보여줄 게 없음, task/evidence=via-parent로 이미
// 열림, asset=별도 스토리지 화면). 이 테스트는 그 경계 자체를 고정한다.
describe('story #2614 AC3 — "미리보기 없음" 문구는 미지원 타입(sprint)에만 정직하게 남는다', () => {
  it('sprint는 own-href로 풋터가 열리면서도 몸통엔 여전히 "미리보기 없음"이 뜬다(의도된 것 — 회귀 아님)', async () => {
    await act(async () => {
      root.render(<EmbedCard entity_type="sprint" entity_id="sp1" title="스프린트 3" status={null} />);
    });
    await openCard();
    await flush();
    expect(document.body.textContent).toContain('이 엔티티는 별도 미리보기가 없습니다');
    expect(document.querySelector('a[href="/sprints?id=sp1"]')).not.toBeNull();
  });
});

describe('AC3/AC4 — evidence는 부모 story로("담긴 곳으로 갑니다", story #2314 승격)', () => {
  it('story #2314(2026-07-29): GET /api/v2/evidence/{id} 개통 前엔 임시 ③이었으나, 이제 fetch해서 ②로 판정한다 — resolved_story_id를 BE가 이미 한 번에 해소해 준다(task처럼 2단 조인 불필요)', async () => {
    stubFetch(async (url) => {
      expect(url).toContain('/api/evidence/');
      return { ok: true, json: async () => ({ data: { resolved_story_id: 's-parent-2' } }) };
    });
    await act(async () => {
      root.render(<EmbedCard entity_type="evidence" entity_id="ev1" title="증거 A" status={null} />);
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
      root.render(<EmbedCard entity_type="evidence" entity_id="ev2" title="증거 B" status={null} />);
    });
    await openCard();
    await flush();
    expect(document.querySelectorAll('a[href^="/board?story="]').length).toBe(0);
    expect(document.body.textContent).toContain('열 수 있는 화면이 없습니다');
  });
});

describe('AC4 — 조회 실패(대상 사라짐)는 "대상이 없습니다"로 다른 문구·회색', () => {
  it('task 상세 fetch가 실패하면 ㉠ "대상이 없습니다"를 보인다(㉡-b "열 수 있는 화면이 없습니다"와 문구가 다르다)', async () => {
    stubFetch(async () => ({ ok: false, json: async () => ({}) }));
    await act(async () => {
      root.render(<EmbedCard entity_type="task" entity_id="t-gone" title="사라진 작업" status={null} />);
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
      root.render(<EmbedCard entity_type="task" entity_id="t1" title="작업 A" status={null} />);
    });
    await openCard();
    await flush();
    expect(document.body.textContent).toContain('진행 중');
    expect(document.body.textContent).not.toContain('in-progress');
  });

  it('status prop이 이미 실려 있으면(EmbedCard 자신의 write-response 경로) 그 값을 번역해 헤더가 우선한다', async () => {
    stubFetch(async () => ({ ok: true, json: async () => ({ data: { status: 'done', story_id: 's-parent' } }) }));
    await act(async () => {
      root.render(<EmbedCard entity_type="task" entity_id="t1" title="작업 A" status="todo" />);
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
      root.render(<EmbedCard entity_type="task" entity_id="t-gone" title="사라진 작업" status={null} />);
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
      root.render(<EmbedCard entity_type="story" entity_id="s1" title="스토리 A" status={null} />);
    });
    await openCard();
    await flush();
    expect(document.body.textContent).toContain('검토 중');
    expect(document.body.textContent).not.toContain('in-review');
  });

  it('epic 본문 status 뱃지가 번역된 말로 뜬다(원시값 active 자체는 겹치므로 archived로 격리해 확認)', async () => {
    stubFetch(async () => ({ ok: true, json: async () => ({ data: { status: 'archived', objective: '목표' } }) }));
    await act(async () => {
      root.render(<EmbedCard entity_type="epic" entity_id="e1" title="에픽 A" status={null} />);
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
      root.render(<EmbedCard entity_type="story" entity_id="s2" title="스토리 B" status={null} />);
    });
    await openCard();
    await flush();
    expect(document.body.textContent).not.toContain('some-brand-new-status');
  });
});
