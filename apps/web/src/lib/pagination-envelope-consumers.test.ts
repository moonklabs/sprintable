// story #2231 AC5 — 커서 페이지네이션 meta(hasMore/has_more/nextCursor/next_cursor)를
// 직접(옵셔널 체이닝으로) 읽는 자리가 새로 생기면 CI가 빨개진다. 새 자리는 두 선택지뿐이다:
//   ① `parseCursorMeta()`(#2231 AC4, lib/pagination.ts)로 위임 — 규약 밖 응답이면 조용히
//      삼키지 않고 console.error로 드러난다.
//   ② 이 파일 하단 ALLOWLIST에 "왜 안전한지" 근거와 함께 추가 — 리뷰 없이 조용히 늘지 않는다.
//
// ⛔이 가드가 못 잡는 것(고의로 남겨둔 한계 — i18n-key-coverage.test.ts와 같은 규율):
//   ① ALLOWLIST 항목의 **런타임 정확성**은 못 잡는다 — 이 시점(2026-07-27)에 각 항목이
//      실제로 소비하는 프록시 라우트의 응답 형태를 1:1로 대조해 「맞다」로 확認한 것뿐이다.
//      그 프록시가 나중에 형태를 바꾸는데 이 클라이언트 파일이 안 바뀌면, 이 가드는
//      여전히 초록이지만 실제로는 깨진다(정적 스캔의 근본 한계 — 실측은 라이브 QA 몫).
//   ② hasMore/nextCursor 외의 이름으로 같은 개념을 나르는 새 규약(D)이 생기면 이 정규식
//      자체가 못 본다 — 그 경우는 새 정규식이 필요하다.
//   ③ 주석 스트립은 근사치다(i18n-key-coverage.test.ts와 동일 방식·동일 한계).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC_ROOT = path.resolve(__dirname, '..');

function stripComments(text: string): string {
  let out = text.replace(/\/\*[\s\S]*?\*\//g, '');
  out = out
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//');
      if (idx === -1) return line;
      const before = line.slice(0, idx);
      const quotes = (before.match(/"/g) || []).length
        + (before.match(/'/g) || []).length
        + (before.match(/`/g) || []).length;
      return quotes % 2 === 0 ? before : line;
    })
    .join('\n');
  return out;
}

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts') && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

// 「meta」 또는 「json.meta」/「beJson.meta」 등에 옵셔널 체이닝으로 곧장 hasMore/has_more/
// nextCursor/next_cursor를 읽는 자리 — parseCursorMeta()를 거치지 않고 casing을 직접 가정하는 자리.
const RAW_ACCESS_RE = /\bmeta\??\.(hasMore|has_more|nextCursor|next_cursor)\b/;

// 2026-07-27 감사 완료 — 각 항목이 실제로 부르는 프록시의 응답 형태와 1:1 대조해 정합 확認.
const ALLOWLIST = new Map<string, string>([
  ['app/(authenticated)/inbox/page.tsx',
    '/api/notifications 소비 — 이 라우트는 FastAPI 프록시가 아니라 repo.list()가 직접 camelCase{hasMore,nextCursor}를 반환(내부 TS, casing 불일치 불가)'],
  ['app/(authenticated)/[ws]/[proj]/sprints/sprints-client.tsx',
    '/api/stories(buildCursorPageMeta)·/api/stories/backlog(수동 camelCase 구성) 둘 다 camelCase — 정합'],
  ['app/(authenticated)/[ws]/[proj]/standup/standup-client.tsx',
    '/api/stories(buildCursorPageMeta) 소비 — camelCase 정합'],
  ['app/(authenticated)/[ws]/[proj]/docs/docs-shell-client.tsx',
    '/api/docs(buildCursorPageMeta) 소비 — camelCase 정합'],
  ['app/(authenticated)/[ws]/[proj]/docs/docs-client-layout.tsx',
    '/api/docs(buildCursorPageMeta) 소비 — camelCase 정합'],
  ['app/api/stories/backlog/route.ts',
    'PRODUCER — X-Next-Cursor/X-Total-Count 헤더를 읽어 camelCase{limit,hasMore,nextCursor}를 직접 구성해 내보냄(#2190). 이 파일이 그 구성 지점이라 스스로는 parseCursorMeta를 쓰지 않음'],
  ['components/chat/chat-view.tsx',
    'conversations 메시지 엔드포인트(#2231 규약 A의 원본 레퍼런스 구현) 직접 소비 — BE 네이티브 snake_case{next_cursor,has_more} 그대로 정합'],
  ['components/kanban/kanban-board.tsx',
    '/api/stories(buildCursorPageMeta) 소비 — camelCase 정합'],
  ['components/nav/notification-bell.tsx',
    '/api/event-notifications 소비 — 커서 아닌 offset+limit 방식(변형 C 계열)이라 hasMore만 있고 nextCursor 자체가 없음. 프록시가 camelCase{hasMore}를 직접 구성 — 정합. 이 가드의 스코프(커서 규약 A) 밖'],
]);

describe('pagination meta 직접 접근 전수 — 새 자리는 parseCursorMeta 또는 승인된 allowlist뿐 (#2231 AC5)', () => {
  it('ALLOWLIST 밖에서 hasMore/has_more/nextCursor/next_cursor를 옵셔널 체이닝으로 직접 읽지 않는다', () => {
    const files = collectSourceFiles(SRC_ROOT);
    const unexpected: string[] = [];

    for (const file of files) {
      const rel = path.relative(SRC_ROOT, file).split(path.sep).join('/');
      if (rel === 'lib/pagination.ts') continue; // 정의부 자신
      const stripped = stripComments(fs.readFileSync(file, 'utf-8'));
      if (RAW_ACCESS_RE.test(stripped) && !ALLOWLIST.has(rel)) {
        unexpected.push(rel);
      }
    }

    if (unexpected.length > 0) {
      throw new Error(
        `커서 페이지네이션 meta를 parseCursorMeta() 없이 직접 읽는 새 자리 ${unexpected.length}곳:\n` +
        unexpected.map((f) => `  ${f}`).join('\n') +
        '\n\n→ parseCursorMeta(json.meta, "출처")로 감싸거나, 정말 안전하면 ' +
        'pagination-envelope-consumers.test.ts의 ALLOWLIST에 근거와 함께 추가할 것.',
      );
    }
    expect(unexpected).toEqual([]);
  });

  it('⛔양성대조 — 탐지 로직 자체가 실제로 위반을 잡고 안전한 것은 통과시키는지(합성 케이스)', () => {
    const violation = `
      const json = await res.json();
      setNextCursor(json.meta?.nextCursor ?? null); // parseCursorMeta 없이 직접 casing 가정
    `;
    const viaParser = `
      const json = await res.json();
      setNextCursor(parseCursorMeta(json.meta, 'x').nextCursor); // 안전 — 위임
    `;
    const inComment = `
      // 예전엔 json.meta?.nextCursor 로 읽었었다(지금은 parseCursorMeta로 교체됨)
      setNextCursor(parseCursorMeta(json.meta, 'x').nextCursor);
    `;

    expect(RAW_ACCESS_RE.test(stripComments(violation))).toBe(true);
    expect(RAW_ACCESS_RE.test(stripComments(viaParser))).toBe(false);
    expect(RAW_ACCESS_RE.test(stripComments(inComment))).toBe(false); // 주석 스트립이 실제로 동작
  });
});
