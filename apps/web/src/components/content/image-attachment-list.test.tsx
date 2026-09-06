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
      .toBe(`이 채널 규격에 맞춰 자동 변환됐습니다: 너비 4000px → 1440px · 용량 ${formatFileSize(5_000_000)} → ${formatFileSize(900_000)}`);
    expect(items[2]!.querySelector('[data-testid="channel-post-image-attachment-converted-badge"]')).toBeNull();
  });

  // story #3563(유나 24회차 결함·§13-3-1 정본, 페드루 PO 確定 2026-09-06) — 「A → B」는
  // 두 값이 다르다는 약속(§13-3-1) — 안 바뀐 축은 그 형으로 적지 않는다.
  it('⭐너비만 바뀌면 용량 조각 없이 너비 조각만', async () => {
    const img: ImageAttachmentItem = {
      url: 'https://storage.googleapis.com/x/w.jpg', wasConverted: true,
      originalWidth: 1440, finalWidth: 1080, originalBytes: 300_000, finalBytes: 300_000,
    };
    await act(async () => { root.render(wrap(<ImageAttachmentList images={[img]} maxCount={10} onReorder={() => {}} onDelete={() => {}} />)); });
    const badge = container.querySelector('[data-testid="channel-post-image-attachment-converted-badge"]')?.textContent;
    expect(badge).toBe('이 채널 규격에 맞춰 자동 변환됐습니다: 너비 1440px → 1080px');
  });

  it('⭐용량만 바뀌면 너비 조각 없이 용량 조각만(⛔「1080px → 1080px」 안 나온다·음성 대조)', async () => {
    const img: ImageAttachmentItem = {
      url: 'https://storage.googleapis.com/x/b.jpg', wasConverted: true,
      originalWidth: 1080, finalWidth: 1080, originalBytes: 30_000, finalBytes: 29_500,
    };
    await act(async () => { root.render(wrap(<ImageAttachmentList images={[img]} maxCount={10} onReorder={() => {}} onDelete={() => {}} />)); });
    const badge = container.querySelector('[data-testid="channel-post-image-attachment-converted-badge"]')?.textContent;
    expect(badge).toBe(`이 채널 규격에 맞춰 자동 변환됐습니다: 용량 ${formatFileSize(30_000)} → ${formatFileSize(29_500)}`);
    expect(badge).not.toContain('1080px → 1080px');
  });

  it('둘 다 바뀌면 두 조각 다 · 로 잇는다', async () => {
    const img: ImageAttachmentItem = {
      url: 'https://storage.googleapis.com/x/wb.jpg', wasConverted: true,
      originalWidth: 4000, finalWidth: 1440, originalBytes: 5_000_000, finalBytes: 900_000,
    };
    await act(async () => { root.render(wrap(<ImageAttachmentList images={[img]} maxCount={10} onReorder={() => {}} onDelete={() => {}} />)); });
    const badge = container.querySelector('[data-testid="channel-post-image-attachment-converted-badge"]')?.textContent;
    expect(badge).toBe(`이 채널 규격에 맞춰 자동 변환됐습니다: 너비 4000px → 1440px · 용량 ${formatFileSize(5_000_000)} → ${formatFileSize(900_000)}`);
  });

  it('⭐둘 다 그대로면 축 조각 없이 기본 문장만(마침표로 끝)', async () => {
    const img: ImageAttachmentItem = {
      url: 'https://storage.googleapis.com/x/same.jpg', wasConverted: true,
      originalWidth: 1080, finalWidth: 1080, originalBytes: 30_000, finalBytes: 30_000,
    };
    await act(async () => { root.render(wrap(<ImageAttachmentList images={[img]} maxCount={10} onReorder={() => {}} onDelete={() => {}} />)); });
    const badge = container.querySelector('[data-testid="channel-post-image-attachment-converted-badge"]')?.textContent;
    expect(badge).toBe('이 채널 규격에 맞춰 자동 변환됐습니다.');
  });

  // 유나 Design 조건 1(2026-09-06, #3919 리뷰) — 판정을 원시 바이트로 하면
  // 10,300B/10,340B처럼 다른 값이 formatFileSize 뒤 같은 문자열("10.1 KB")로
  // 반올림돼 「용량 10.1 KB → 10.1 KB」가 그대로 뜬다(너비와 같은 병).
  it('⭐용량이 바뀌어도 표시 문자열이 같으면(10300B→10340B, 둘 다 "10.1 KB") 용량 조각 없음', async () => {
    const img: ImageAttachmentItem = {
      url: 'https://storage.googleapis.com/x/round.jpg', wasConverted: true,
      originalWidth: 1080, finalWidth: 1080, originalBytes: 10_300, finalBytes: 10_340,
    };
    await act(async () => { root.render(wrap(<ImageAttachmentList images={[img]} maxCount={10} onReorder={() => {}} onDelete={() => {}} />)); });
    const badge = container.querySelector('[data-testid="channel-post-image-attachment-converted-badge"]')?.textContent;
    expect(badge).toBe('이 채널 규격에 맞춰 자동 변환됐습니다.');
    expect(badge).not.toContain('10.1 KB → 10.1 KB');
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
