import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiSuccess, apiSuccessRawJson } from './api-response';

// [SID:4299 AC2 꼬리] stories unattached 갈래 — 상류 본문을 파싱 · 재직렬화하지 않고 봉투에 글자 그대로 끼운다.
// 약속: (1) 상류가 조밀한 JSON 글자면 응답 바이트 · 상태 · content-type이 옛 apiSuccess와 같다 (2) 빠른 길에서 JSON.parse 0
// (3) 겉이 JSON 배열 · 객체가 아니면 옛 길 그대로(깨진 본문은 전과 같이 던짐).

/** 실제 StoryResponse 모양(backend/app/schemas/story.py) — 한글 · 이모지 · 따옴표 · 줄바꿈 · 역슬래시 · null · 빈 배열 · 중첩 객체. */
function story(i: number) {
  return {
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    story_number: 4000 + i,
    project_id: 'f3e6ed64-447d-4b1c-ad78-a00cfba715a7',
    org_id: '54bac162-5c0d-49fa-8e49-85977063a091',
    epic_id: null,
    sprint_id: i % 3 ? null : 'sprint-1',
    assignee_ids: [],
    agent_delegate_ids: ['ba22db91-3c61-4dee-a5a1-06f5ecf0a7af'],
    references: i % 2 ? null : { docs: ['e-mobile-blueprint'], note: '«참고» — "따옴표"' },
    is_reference_candidate: false,
    attachments: [],
    title: `[웹·접근성] 아이콘만 있는 버튼 ${i} — «✕» 🚀`,
    status: 'backlog',
    priority: 'medium',
    story_points: i % 5,
    description: `## 출처\n유나 PR 4753 화면 판 곁 발견.\n\`코드\` \\ 역슬래시 · 탭\t끝 · ${'가나다라마바사 '.repeat(40)}`,
    acceptance_criteria: 'AC1 …\nAC2 …',
    metric_definition: null,
    measure_after: '2026-09-28T01:13:41.362723Z',
  };
}
const UPSTREAM = JSON.stringify(Array.from({ length: 100 }, (_, i) => story(i)));

afterEach(() => { vi.restoreAllMocks(); });

describe('apiSuccessRawJson — [SID:4299] 파싱 · 재직렬화 없이 봉투', () => {
  it.each([
    ['totalCount 있음', { totalCount: 2180 }],
    ['totalCount 모름(null)', { totalCount: null }],
    ['meta 없음', undefined],
  ])('⭐응답 바이트 · 상태 · content-type이 옛 apiSuccess(JSON.parse(본문))와 같다 — %s', async (_label, meta) => {
    const before = apiSuccess(JSON.parse(UPSTREAM), meta);
    const after = apiSuccessRawJson(UPSTREAM, meta);
    expect(after.status).toBe(before.status);
    expect(after.headers.get('content-type')).toBe(before.headers.get('content-type'));
    const [b, a] = [await before.text(), await after.text()];
    expect(new TextEncoder().encode(a).length).toBeGreaterThan(150_000); // 실제 크기 급(100행 · 설명 포함 · 바이트)
    expect(a).toBe(b);
  });

  it('빠른 길에서는 본문을 JSON.parse하지 않는다(이 PR이 빼는 비용)', () => {
    const parse = vi.spyOn(JSON, 'parse');
    apiSuccessRawJson(UPSTREAM, { totalCount: 1 });
    expect(parse).not.toHaveBeenCalled();
  });

  it('상류가 공백 섞인 JSON이면 바이트는 달라도 뜻(파싱 결과)은 같다', async () => {
    const pretty = `\n ${JSON.stringify([story(1), story(2)], null, 2)} \n`;
    const a = await apiSuccessRawJson(pretty, { totalCount: 2 }).json();
    const b = await apiSuccess(JSON.parse(pretty), { totalCount: 2 }).json();
    expect(a).toEqual(b);
  });

  it('겉이 JSON 배열 · 객체가 아니면 옛 길 — JSON이면 그대로 감싸고, 깨진 본문은 전과 같이 던진다', async () => {
    expect(await apiSuccessRawJson('null').json()).toEqual({ data: null, error: null, meta: null });
    expect(() => apiSuccessRawJson('<html>502 Bad Gateway</html>')).toThrow(SyntaxError);
    expect(() => apiSuccessRawJson('')).toThrow(SyntaxError);
  });
});
