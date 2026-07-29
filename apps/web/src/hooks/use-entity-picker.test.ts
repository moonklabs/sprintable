/**
 * story #2263 BE 계약②(PR#2615) — `/api/v2/entities/search`가 flat list에서 `{data, types}`로
 * 바뀐 뒤, Next.js route(apiSuccess)의 이중 wrap을 뚫고 실제 배열을 뽑아내는지 고정한다.
 * ⛔이 테스트가 없던 채로 PR#2615가 merge됐으면 검색 결과가 조용히 0건이 되는 회귀가 났다.
 */
import { describe, expect, it } from 'vitest';
import { parseEntitySearchResults } from './use-entity-picker';

const item = { entity_type: 'story', entity_id: 's1', title: 'S1', status: null };

describe('parseEntitySearchResults', () => {
  it('과거 형태: Next.js가 flat list를 한 겹만 감싼 {data: [...]}에서 배열을 뽑는다', () => {
    expect(parseEntitySearchResults({ data: [item], error: null, meta: null })).toEqual([item]);
  });

  it('⭐현재 형태(PR#2615): FastAPI가 {data,types}로 바뀐 뒤 Next.js가 또 감싼 이중 wrap을 뚫는다', () => {
    const json = { data: { data: [item], types: { story: { shown: 1, total: 1 } } }, error: null, meta: null };
    expect(parseEntitySearchResults(json)).toEqual([item]);
  });

  it('방어적: json 자체가 이미 flat array인 경우도 받는다', () => {
    expect(parseEntitySearchResults([item])).toEqual([item]);
  });

  it('방어적: 알 수 없는 모양은 빈 배열로 떨어진다(throw 0)', () => {
    expect(parseEntitySearchResults(null)).toEqual([]);
    expect(parseEntitySearchResults(undefined)).toEqual([]);
    expect(parseEntitySearchResults({})).toEqual([]);
    expect(parseEntitySearchResults({ data: { types: {} } })).toEqual([]);
  });
});
