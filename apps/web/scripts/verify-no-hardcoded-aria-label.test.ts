import { describe, expect, it } from 'vitest';
import { findHardcodedAriaLabels, scanRepository } from './verify-no-hardcoded-aria-label';
import { measureFsReads } from './test-utils/fs-work';

describe('findHardcodedAriaLabels — 단위(패턴 자체)', () => {
  it('aria-label={`Move ${item} up`} 를 잡는다', () => {
    const hits = findHardcodedAriaLabels('<Button aria-label={`Move ${item} up`}>↑</Button>');
    expect(hits.length).toBe(1);
  });

  it('t(...) 호출은 안 잡는다(양성대조)', () => {
    const hits = findHardcodedAriaLabels("<Button aria-label={t('moveItemUpAction', { item })}>↑</Button>");
    expect(hits.length).toBe(0);
  });

  it('한국어 하드코딩 문자열은 이 스캔의 관심사가 아니다(§17-20은 t(...) 축, 이 가드는 «영문» 축만)', () => {
    const hits = findHardcodedAriaLabels('<Button aria-label={`위로 이동`}>↑</Button>');
    expect(hits.length).toBe(0);
  });
});

describe('story #3557 회귀가드 — 전수 스캔 0건', () => {
  // story #4333 — 시한은 기본(행 가드 · 벽시계 예산 폐기). 일의 양은 결정적으로 — 한 스캔에서 같은 파일을 두 번 읽으면 RED(measureFsReads).
  it('새 FAIL은 없다(#3557이 알려진 3곳을 전부 고친 뒤의 clean-slate)', () => {
    const { result: __scan, maxPerFile, files: __filesRead } = measureFsReads(() => scanRepository());
    expect(maxPerFile.count, `${maxPerFile.file} — 한 스캔에서 두 번 이상 읽음(일이 늘었다)`).toBeLessThanOrEqual(1);
    expect(__filesRead, '읽기를 실제로 셌다(헛돌지 않게)').toBeGreaterThan(0);
    expect(__scan).toEqual([]);
  });
});
