/**
 * story #4218 — `RESERVED_FIRST_SEGMENTS`(src/lib/reserved-first-segments.ts)를 평가한 값을
 * `src/lib/reserved-first-segments.json`으로 쓴다. 백엔드(Python)는 이 JSON만 읽어 workspace slug
 * 예약어와 맞추고(backend/tests/test_4218_reserved_workspace_slugs_sync.py) TS를 직접 파싱하지 않는다.
 * JSON이 모듈과 어긋나면 `src/lib/reserved-first-segments-json.test.ts`가 RED — 그때 이 스크립트를 다시 돌린다.
 *
 *   pnpm --filter web gen:reserved-first-segments-json
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RESERVED_FIRST_SEGMENTS } from '../src/lib/reserved-first-segments';

export const RESERVED_FIRST_SEGMENTS_JSON_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../src/lib/reserved-first-segments.json',
);

export function renderReservedFirstSegmentsJson(): string {
  const segments = [...RESERVED_FIRST_SEGMENTS].sort();
  return `${JSON.stringify(
    {
      _generated_by: 'apps/web/scripts/write-reserved-first-segments-json.ts — 손으로 고치지 말 것',
      segments,
    },
    null,
    2,
  )}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  writeFileSync(RESERVED_FIRST_SEGMENTS_JSON_PATH, renderReservedFirstSegmentsJson());
  console.log(`wrote ${RESERVED_FIRST_SEGMENTS_JSON_PATH}`);
}
