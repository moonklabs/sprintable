import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { MdBody } from './embed-card';

// story #2639(미르코 리뷰 ⑤) — 결재 카드 문서 미리보기(EntityPreviewModal→EntityDetail doc
// 분기)가 쓰는 경량 렌더러 MdBody도 entity: 참조를 앱 내 엔티티로 잇는다(doc-content-renderer와
// 동형). 최소셋: 칩 렌더 + 보안 차단.
describe('MdBody entity: wiring (story #2639)', () => {
  it('renders entity refs as interactive chips (not dead links) — story·epic·doc', () => {
    const uuid = '11111111-1111-1111-1111-111111111111';
    const markup = renderToStaticMarkup(
      <MdBody
        content={`[스토리제목](entity:story:${uuid}) [에픽제목](entity:epic:${uuid}) [문서제목](entity:doc:${uuid})`}
      />,
    );

    // 죽은 앵커가 아니라 상호작용 칩(button)으로 렌더. 라벨 3종 모두 살아 있다.
    expect(markup).toContain('<button type="button"');
    expect(markup).toContain('스토리제목');
    expect(markup).toContain('에픽제목');
    expect(markup).toContain('문서제목');
    // 유효 UUID 3종은 전부 칩으로 흡수 → entity: 원시 스킴이 앵커 href로 새지 않는다.
    expect(markup).not.toContain('href="entity:');
  });

  // 뮤테이션 가드 — MdBody의 urlTransform이 빠지면 href가 지워져 정규식 매칭 실패,
  // 평문 링크로 떨어지고 이 assertion(button)이 깨진다.
  it('mutation guard: entity: scheme preserved by urlTransform', () => {
    const uuid = '22222222-2222-2222-2222-222222222222';
    const markup = renderToStaticMarkup(<MdBody content={`[칩라벨](entity:story:${uuid})`} />);
    expect(markup).toContain('<button type="button"');
    expect(markup).toContain('칩라벨');
  });

  // 보안 비회귀 — entity: 예외가 다른 위험 스킴을 함께 열어주지 않는다.
  it('security non-regression: javascript:/data: hrefs are still stripped', () => {
    const markup = renderToStaticMarkup(
      <MdBody content={'[x](javascript:alert(1)) [y](data:text/plain,hi)'} />,
    );
    expect(markup).not.toContain('javascript:');
    expect(markup).not.toContain('data:text/plain');
  });
});
