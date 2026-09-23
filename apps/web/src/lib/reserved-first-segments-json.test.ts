// story #4218 — 커밋된 `reserved-first-segments.json`(백엔드가 workspace slug 예약어와 맞출 때 읽는 유일한 산출물)이
// 실제 모듈을 평가한 `RESERVED_FIRST_SEGMENTS`와 같은지. 백엔드는 TS를 파싱하지 않고 이 JSON만 읽는다 — 그래서 JSON이
// 모듈과 어긋나는 순간을 여기(node에서 실제 import)가 잡아야 한다.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  RESERVED_FIRST_SEGMENTS_JSON_PATH,
  renderReservedFirstSegmentsJson,
} from '../../scripts/write-reserved-first-segments-json';
import { RESERVED_FIRST_SEGMENTS } from './reserved-first-segments';

const REGENERATE = 'pnpm --filter web gen:reserved-first-segments-json';

describe('reserved-first-segments.json — story #4218', () => {
  it('커밋된 JSON이 RESERVED_FIRST_SEGMENTS 평가값과 같다(다르면 재생성)', () => {
    const committed = JSON.parse(readFileSync(RESERVED_FIRST_SEGMENTS_JSON_PATH, 'utf8')) as { segments: string[] };
    const evaluated = [...RESERVED_FIRST_SEGMENTS].sort();
    expect(
      committed.segments,
      `reserved-first-segments.json이 모듈과 어긋남 — \`${REGENERATE}\`로 다시 쓰고 커밋할 것`,
    ).toEqual(evaluated);
  });

  it('파일 바이트까지 생성기 출력과 같다(손 편집·정렬 흔들림 방지)', () => {
    expect(
      readFileSync(RESERVED_FIRST_SEGMENTS_JSON_PATH, 'utf8'),
      `reserved-first-segments.json을 손으로 고치지 말 것 — \`${REGENERATE}\``,
    ).toBe(renderReservedFirstSegmentsJson());
  });
});
