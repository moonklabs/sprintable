// @vitest-environment jsdom
//
// story #3550(Phase2·풀스택 골격, PO 決定 2026-09-06) — Instagram 캐러셀 N장 첨부 UI.
// BE 계약(업로드 다중화·순서 API) 확定 前 골격 — 이 컴포넌트는 순수 표시+로컬
// 재배열/삭제 콜백만 진다(부모가 계약 확定 뒤 실 API에 배선).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ImageAttachmentList, type ImageAttachmentItem } from './image-attachment-list';
import { formatFileSize } from '@/components/docs/extensions/file-node';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

const IMG_1: ImageAttachmentItem = {
  url: 'https://storage.googleapis.com/x/1.jpg', wasConverted: false,
  originalWidth: null, finalWidth: null, originalBytes: null, finalBytes: null,
};
const IMG_2: ImageAttachmentItem = {
  url: 'https://storage.googleapis.com/x/2.jpg', wasConverted: true,
  originalWidth: 4000, finalWidth: 1440, originalBytes: 5_000_000, finalBytes: 900_000,
};
const IMG_3: ImageAttachmentItem = {
  url: 'https://storage.googleapis.com/x/3.jpg', wasConverted: false,
  originalWidth: null, finalWidth: null, originalBytes: null, finalBytes: null,
};

describe('ImageAttachmentList(story #3550)', () => {
  it('N장 각각 렌더 + 개수 태그(count/max)', async () => {
    await act(async () => {
      root.render(wrap(
        <ImageAttachmentList images={[IMG_1, IMG_2, IMG_3]} maxCount={10} onReorder={() => {}} onDelete={() => {}} />,
      ));
    });
    expect(container.querySelectorAll('[data-testid="channel-post-image-attachment-item"]').length).toBe(3);
    expect(container.querySelector('[data-testid="channel-post-image-count-tag"]')?.textContent).toBe('3 / 10장');
  });

  it('§13-3 — 변환 배지는 장별로 그린다(2번째만 변환됐으면 2번째에만 뜬다)', async () => {
    await act(async () => {
      root.render(wrap(
        <ImageAttachmentList images={[IMG_1, IMG_2, IMG_3]} maxCount={10} onReorder={() => {}} onDelete={() => {}} />,
      ));
    });
    const items = container.querySelectorAll('[data-testid="channel-post-image-attachment-item"]');
    expect(items[0]!.querySelector('[data-testid="channel-post-image-attachment-converted-badge"]')).toBeNull();
    expect(items[1]!.querySelector('[data-testid="channel-post-image-attachment-converted-badge"]')?.textContent)
      .toBe(koMessages.content.channelPostsImageConvertedBadge
        .replace('{originalWidth}', '4000').replace('{finalWidth}', '1440')
        .replace('{originalBytes}', formatFileSize(5_000_000)).replace('{finalBytes}', formatFileSize(900_000)));
    expect(items[2]!.querySelector('[data-testid="channel-post-image-attachment-converted-badge"]')).toBeNull();
  });

  it('첫 장은 위로 이동 비활성, 마지막 장은 아래로 이동 비활성', async () => {
    await act(async () => {
      root.render(wrap(
        <ImageAttachmentList images={[IMG_1, IMG_2, IMG_3]} maxCount={10} onReorder={() => {}} onDelete={() => {}} />,
      ));
    });
    const items = container.querySelectorAll('[data-testid="channel-post-image-attachment-item"]');
    expect((items[0]!.querySelector('[data-testid="channel-post-image-attachment-move-up"]') as HTMLButtonElement).disabled).toBe(true);
    expect((items[0]!.querySelector('[data-testid="channel-post-image-attachment-move-down"]') as HTMLButtonElement).disabled).toBe(false);
    expect((items[2]!.querySelector('[data-testid="channel-post-image-attachment-move-down"]') as HTMLButtonElement).disabled).toBe(true);
    expect((items[2]!.querySelector('[data-testid="channel-post-image-attachment-move-up"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('가운데 장 위로 이동 클릭 — onReorder(1, 0) 호출(현재 인덱스, 목표 인덱스)', async () => {
    const onReorder = vi.fn();
    await act(async () => {
      root.render(wrap(
        <ImageAttachmentList images={[IMG_1, IMG_2, IMG_3]} maxCount={10} onReorder={onReorder} onDelete={() => {}} />,
      ));
    });
    const items = container.querySelectorAll('[data-testid="channel-post-image-attachment-item"]');
    await act(async () => {
      (items[1]!.querySelector('[data-testid="channel-post-image-attachment-move-up"]') as HTMLButtonElement).click();
    });
    expect(onReorder).toHaveBeenCalledWith(1, 0);
  });

  it('삭제 클릭 — onDelete(index) 호출', async () => {
    const onDelete = vi.fn();
    await act(async () => {
      root.render(wrap(
        <ImageAttachmentList images={[IMG_1, IMG_2, IMG_3]} maxCount={10} onReorder={() => {}} onDelete={onDelete} />,
      ));
    });
    const items = container.querySelectorAll('[data-testid="channel-post-image-attachment-item"]');
    await act(async () => {
      (items[2]!.querySelector('[data-testid="channel-post-image-attachment-delete"]') as HTMLButtonElement).click();
    });
    expect(onDelete).toHaveBeenCalledWith(2);
  });

  // 유나 §17 PASS 권고② 정정(2026-09-06) — N개 버튼이 "몇 번째 이미지"인지 지어야
  // 스크린리더가 「삭제」「삭제」만 반복해 듣지 않는다. 삭제 aria-label은 보이는
  // 글자("삭제")를 덧붙여 포함하는 별도 키(channelPostsImageRemoveActionLabel).
  it('⭐이동·삭제 버튼 aria-label이 "몇 번째 이미지"인지 각각 다르게 진다', async () => {
    await act(async () => {
      root.render(wrap(
        <ImageAttachmentList images={[IMG_1, IMG_2, IMG_3]} maxCount={10} onReorder={() => {}} onDelete={() => {}} />,
      ));
    });
    const items = container.querySelectorAll('[data-testid="channel-post-image-attachment-item"]');
    expect((items[0]!.querySelector('[data-testid="channel-post-image-attachment-move-up"]') as HTMLButtonElement).getAttribute('aria-label'))
      .toBe('1번째 이미지 위로 이동');
    expect((items[1]!.querySelector('[data-testid="channel-post-image-attachment-move-down"]') as HTMLButtonElement).getAttribute('aria-label'))
      .toBe('2번째 이미지 아래로 이동');
    expect((items[2]!.querySelector('[data-testid="channel-post-image-attachment-delete"]') as HTMLButtonElement).getAttribute('aria-label'))
      .toBe('3번째 이미지 삭제');
  });

  it('disabled=true — 이동·삭제 버튼 전부 비활성(업로드 진행 중 등)', async () => {
    await act(async () => {
      root.render(wrap(
        <ImageAttachmentList images={[IMG_1, IMG_2]} maxCount={10} disabled onReorder={() => {}} onDelete={() => {}} />,
      ));
    });
    const buttons = container.querySelectorAll('button');
    expect(buttons.length).toBeGreaterThan(0);
    expect([...buttons].every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  });
});
