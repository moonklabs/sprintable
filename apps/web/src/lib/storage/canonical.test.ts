import { describe, expect, it } from 'vitest';
import { canonicalObjectPath } from './canonical';

// story #2720(2026-08-17) — FE canonicalization SSOT 단위 + BE↔FE 대조(AC3).
//
// ⚠️짝 파일: backend/tests/test_2720_canonicalization_cross_language_parity.py의
// `PARITY_VECTORS`(아래와 동일 input/expected 쌍) — 한쪽만 고치고 다른 쪽을 안 고치면 이
// 주석이 거짓말이 되니, 벡터를 바꿀 땐 반드시 두 파일을 함께 갱신한다.

const BUCKET = 'sprintable-memo-attachments';
const PREFIX = `https://storage.googleapis.com/${BUCKET}/`;

const PARITY_VECTORS: Array<[string, string | null]> = [
  [`${PREFIX}chat/p/c/u-a.png`, 'chat/p/c/u-a.png'],
  ['story/p/s/u-a.png', 'story/p/s/u-a.png'],
  [
    `${PREFIX}org/o1/project/p1/canvas-import/abc-shot.png?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Signature=deadbeef`,
    'org/o1/project/p1/canvas-import/abc-shot.png',
  ],
  ['http://evil/a.png', null],
  ['https://storage.googleapis.com/other-bucket/a.png', null],
  ['gs://other-bucket/a.png', null],
  ['file:///etc/passwd', null],
  [`http://evil.com/${BUCKET}/a.png`, null],
  ['', null],
  [PREFIX, null],
];

describe('canonicalObjectPath', () => {
  it.each(PARITY_VECTORS)('%s → %s (BE 대조 벡터와 정합)', (input, expected) => {
    expect(canonicalObjectPath(input, BUCKET)).toBe(expected);
  });
});
