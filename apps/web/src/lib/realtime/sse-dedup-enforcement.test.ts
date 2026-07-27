// story #2102 ② — SSE handler가 dedup을 거치는지 정적 스캔으로 검사(HOC 강제 불가 실증 이후의
// 유일한 기계적 수단, sse-event-dedup.ts 설계 이력 참고).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { callsDedup, findUndeclaredSseHandlers, isLikelySseConsumer, type SourceFile } from './sse-dedup-enforcement';

describe('findUndeclaredSseHandlers — 순수 함수, 합성 fixture(AC1/AC2: 판정+실패케이스 실증)', () => {
  it('mux.subscribe를 쓰면서 dedup 호출도 exempt 등록도 없으면 잡는다(실패케이스 실증)', () => {
    const files: SourceFile[] = [
      { path: 'fake-new-handler.ts', content: `mux.subscribe('story.foo_changed', (raw) => { doStuff(raw); });` },
    ];
    expect(findUndeclaredSseHandlers(files, {})).toEqual(['fake-new-handler.ts']);
  });

  it('dedup을 호출하면 안 잡는다(오탐 없음, AC3)', () => {
    const files: SourceFile[] = [
      {
        path: 'good-handler.ts',
        content: `mux.subscribe('story.foo_changed', (raw) => {\n  if (shouldSuppressDuplicateSseEvent(raw)) return;\n  doStuff(raw);\n});`,
      },
    ];
    expect(findUndeclaredSseHandlers(files, {})).toEqual([]);
  });

  it('exempt 등록에 근거 문자열이 있으면 안 잡는다(정당한 면제, AC3)', () => {
    const files: SourceFile[] = [
      { path: 'presence-like.ts', content: `mux.subscribe('presence', () => { refetch(); });` },
    ];
    const exemptions = { 'presence-like.ts': 'payload 미사용 — refetch 트리거뿐이라 재배달이 무해(멱등)' };
    expect(findUndeclaredSseHandlers(files, exemptions)).toEqual([]);
  });

  it('exempt 등록이 있어도 근거가 빈 문자열이면 여전히 잡는다(무근거 면제 방지)', () => {
    const files: SourceFile[] = [
      { path: 'lazy-exempt.ts', content: `mux.subscribe('story.bar_changed', (raw) => { doStuff(raw); });` },
    ];
    expect(findUndeclaredSseHandlers(files, { 'lazy-exempt.ts': '   ' })).toEqual(['lazy-exempt.ts']);
  });

  it('SSE를 아예 구독하지 않는 파일은 무관하게 통과한다(오탐 없음)', () => {
    const files: SourceFile[] = [
      { path: 'unrelated.ts', content: `export function add(a: number, b: number) { return a + b; }` },
    ];
    expect(findUndeclaredSseHandlers(files, {})).toEqual([]);
  });

  it('EventSource addEventListener 폴백 경로 형태도 잡는다(패턴 커버리지)', () => {
    const files: SourceFile[] = [
      { path: 'fallback-handler.ts', content: `es.addEventListener('conversation.working', (e) => { handle(e.data); });` },
    ];
    expect(findUndeclaredSseHandlers(files, {})).toEqual(['fallback-handler.ts']);
  });
});

describe('isLikelySseConsumer / callsDedup — 개별 휴리스틱', () => {
  it('mux.subscribe와 addEventListener(dotted/알려진 bare 이름) 둘 다 SSE 소비자로 인식한다', () => {
    expect(isLikelySseConsumer(`mux.subscribe('story.status_changed', fn)`)).toBe(true);
    expect(isLikelySseConsumer(`es.addEventListener('conversation.working', fn)`)).toBe(true);
    expect(isLikelySseConsumer(`es.addEventListener('presence', fn)`)).toBe(true);
  });

  it('점 없는 일반 DOM 이벤트명은 SSE 소비자로 안 잡는다(오탐 방지 — 실 소스트리에서 발견된 케이스)', () => {
    expect(isLikelySseConsumer(`document.addEventListener('keydown', fn)`)).toBe(false);
    expect(isLikelySseConsumer(`window.addEventListener('resize', fn)`)).toBe(false);
    expect(isLikelySseConsumer(`mql.addEventListener('change', fn)`)).toBe(false);
  });

  it('dedup 호출 유무를 정확히 가른다', () => {
    expect(callsDedup(`if (shouldSuppressDuplicateSseEvent(raw)) return;`)).toBe(true);
    expect(callsDedup(`doStuff(raw);`)).toBe(false);
  });
});

// AC1 실제 강제 — 현재 실 소스트리에 SSE named-event를 구독하면서 dedup도 exempt도 없는
// 파일이 없는 것을 고정한다. 새 파일이 이 조건을 어기면 이 테스트가 빨개진다(story #2102 ②의
// 실물 게이트). exemptions는 판단 근거를 코드로 남겨두는 자리이지, 검사를 우회하는 자리가 아니다.
describe('실 소스트리 게이트(story #2102 ② — 관례 대신 검사)', () => {
  const REALTIME_DIR = path.resolve(__dirname); // apps/web/src/lib/realtime
  const HOOKS_DIR = path.resolve(__dirname, '../../hooks');
  const KANBAN_DIR = path.resolve(__dirname, '../../components/kanban');
  const PRESENCE_DIR = path.resolve(__dirname, '../../components/presence'); // use-team-presence.ts는 hooks/가 아니라 여기(실측으로 발견 — 첫 시도에서 경로 오기로 exemption이 적용 안 되고 있었음)

  // ⚠️ 예외 등록 — 각 근거는 그라운딩된 사실(코드로 확認한 것)만 적는다.
  const EXEMPTIONS: Record<string, string> = {
    [path.join(REALTIME_DIR, 'sse-multiplexer.ts')]:
      'onmessage/onerror 등 인프라 배선 자체 — payload를 최종 소비하는 handler가 아니라 named 이벤트를 attach만 함(dispatchNamed으로 위임)',
    [path.join(PRESENCE_DIR, 'use-team-presence.ts')]:
      "presence 이벤트 핸들러가 payload를 쓰지 않고 refetch()만 트리거함(subscribe('presence', () => scheduleFetchPresence())) — 재배달돼도 refetch 1회 더 도는 것뿐이라 무해(멱등). 계약상 dedup 불필요하다는 판단(story #2162 조사와 별개 판단).",
    [path.join(KANBAN_DIR, 'kanban-board.tsx')]:
      "story.status_changed/assignee_changed 페이로드에 event_id 필드 자체가 없음(backend/app/services/story_status_events.py의 event_data 딕셔너리 확認 — event_id 키 부재). dedup 함수를 호출해도 extractSseEventId가 항상 null을 반환해 no-op이라 지금 호출해도 실효가 없음 — event_id를 payload에 추가하는 BE 변경이 선행돼야 함(#2102 밖, 별건 필요).",
  };

  // 이 스캐너 자신(구현+테스트)은 대상에서 뺀다 — 자기 소스 문자열 안에 스캔 패턴 예시가
  // 그대로 들어있어 자기참조로 오탐한다(실측: 나이브하게 포함시켰다가 자기 자신이 걸리는 것
  // 확認 후 제외 — 메타툴은 handler가 아니므로 스캔 대상이 아닌 것이 맞다).
  const SELF_EXCLUDE = new Set(['sse-dedup-enforcement.ts', 'sse-dedup-enforcement.test.ts']);

  function collectSourceFiles(dir: string): SourceFile[] {
    const out: SourceFile[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) continue; // 얕게만 — 대상 3개 디렉토리는 평평함
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      if (/\.test\.tsx?$/.test(entry.name)) continue;
      if (SELF_EXCLUDE.has(entry.name)) continue;
      out.push({ path: full, content: fs.readFileSync(full, 'utf-8') });
    }
    return out;
  }

  it('lib/realtime + hooks + kanban 전체에서 미선언 SSE handler가 0건이다', () => {
    const files = [
      ...collectSourceFiles(REALTIME_DIR),
      ...collectSourceFiles(HOOKS_DIR),
      ...collectSourceFiles(KANBAN_DIR),
      ...collectSourceFiles(PRESENCE_DIR),
    ];
    const flagged = findUndeclaredSseHandlers(files, EXEMPTIONS);
    expect(flagged).toEqual([]);
  });
});
