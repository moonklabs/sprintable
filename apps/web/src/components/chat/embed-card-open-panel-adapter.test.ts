// story #2905(#3322 QA 채무, 카디르 지적) — 「open-panel 클릭 왕복이 레포 전체에서 테스트
// 0건」: 이 어댑터를 no-op으로 무력화해도 기존 테스트가 전부 통과했다(값으로 잡는 회귀가드
// 부재). 이 파일이 그 사각을 직접 닫는다 — 어댑터 하나만 단독으로, 5-인자 위치 시그니처가
// 정확한 필드명으로 ReadingPanelTarget에 매핑되는지 값으로 검증한다.
import { describe, expect, it, vi } from 'vitest';
import { toEmbedCardOpenPanel } from './embed-card-open-panel-adapter';
import type { ReadingPanelTarget } from './reading-panel';

describe('toEmbedCardOpenPanel — story #2905 open-panel 어댑터 회귀가드', () => {
  it('onOpenReadingPanel이 없으면(undefined) undefined를 반환한다(EmbedCard가 그 자리에서 클릭 핸들러 자체를 안 단다)', () => {
    expect(toEmbedCardOpenPanel(undefined)).toBeUndefined();
  });

  it('5-인자(entityType, entityId, title, status, href)를 정확한 필드명의 ReadingPanelTarget으로 매핑해 호출한다', () => {
    const onOpenReadingPanel = vi.fn<(target: ReadingPanelTarget) => void>();
    const adapted = toEmbedCardOpenPanel(onOpenReadingPanel);
    expect(adapted).toBeDefined();
    adapted!('story', 's-1', '스토리 제목', 'in-progress', '/board?story=s-1');
    expect(onOpenReadingPanel).toHaveBeenCalledTimes(1);
    expect(onOpenReadingPanel).toHaveBeenCalledWith({
      kind: 'entity',
      entityType: 'story',
      entityId: 's-1',
      title: '스토리 제목',
      status: 'in-progress',
      href: '/board?story=s-1',
    });
  });

  it('title/status/href가 null이어도(EmbedCard가 종종 넘기는 값) 그대로 null로 통과한다(지어내지 않음)', () => {
    const onOpenReadingPanel = vi.fn<(target: ReadingPanelTarget) => void>();
    const adapted = toEmbedCardOpenPanel(onOpenReadingPanel)!;
    adapted('artifact', 'a-1', null, null, null);
    expect(onOpenReadingPanel).toHaveBeenCalledWith({
      kind: 'entity',
      entityType: 'artifact',
      entityId: 'a-1',
      title: null,
      status: null,
      href: null,
    });
  });
});
