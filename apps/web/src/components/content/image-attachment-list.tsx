import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { formatFileSize } from '@/components/docs/extensions/file-node';

// story #3550(Phase2·풀스택, PO 決定 2026-09-06) — Instagram 캐러셀 N장 첨부.
// 업로드 자체(파일 선택·서명 URL·PUT·confirm)는 부모(channel-posts/[draftId]/
// page.tsx)가 진다 — 이 컴포넌트는 이미 첨부된 N장의 표시·재배열·삭제만 맡는다
// (onReorder/onDelete를 부모가 실 API에 배선, BE 2/2 #3910 계약).
//
// §13-3(디디 재확인, 2026-09-06 — 단일 슬롯 옛 §13-8 인용은 #3549 오귀속 정정) "있는
// 그대로 그린다" — 변환 배지(image_was_converted)는 승인 카드와 같은 문구를 공유한다는
// 결정을 N장 각각에 그대로 적용한다(장별 배지, 하나로 뭉치지 않는다 — 각 이미지가
// 저마다 다른 변환을 겪을 수 있어서다).
//
// 재배열은 위/아래 버튼이다(드래그 아님) — STEER 로드맵 조타 FE 교훈(synthetic mouse
// dnd-kit이 이 스택에서 비활성이라 신뢰 못 함) 재사용, 접근성도 버튼이 기본으로 더 낫다.
export interface ImageAttachmentItem {
  /** 업로드 확定 응답의 image_url — BE 계약 확定 전엔 프론트가 미리보기용으로만 쓴다. */
  url: string;
  wasConverted: boolean;
  originalWidth: number | null;
  finalWidth: number | null;
  originalBytes: number | null;
  finalBytes: number | null;
}

export interface ImageAttachmentListProps {
  images: ImageAttachmentItem[];
  maxCount: number;
  disabled?: boolean;
  onReorder: (fromIndex: number, toIndex: number) => void;
  onDelete: (index: number) => void;
}

export function ImageAttachmentList({ images, maxCount, disabled, onReorder, onDelete }: ImageAttachmentListProps) {
  const t = useTranslations('content');

  return (
    <div className="space-y-2" data-testid="channel-post-image-attachment-list">
      <p className="text-xs text-muted-foreground" data-testid="channel-post-image-count-tag">
        {t('channelPostsImageCountTag', { count: images.length, max: maxCount })}
      </p>
      <ul className="space-y-2">
        {images.map((img, index) => (
          <li
            key={img.url}
            className="flex items-center gap-3 rounded-md border border-border p-2"
            data-testid="channel-post-image-attachment-item"
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- 단일 슬롯(page.tsx:1830)과 동형 관례: public-read GCS 오브젝트 URL, next/image 대상 밖. */}
            <img
              src={img.url} alt={t('channelPostsImageAttachAlt')}
              className="h-16 w-16 shrink-0 rounded object-cover" data-testid="channel-post-image-attachment-preview"
            />
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-xs text-muted-foreground" data-testid="channel-post-image-attachment-position">
                {t('channelPostsImageAttachmentPosition', { position: index + 1 })}
              </p>
              {img.wasConverted ? (
                <p className="text-xs text-muted-foreground" data-testid="channel-post-image-attachment-converted-badge">
                  {t('channelPostsImageConvertedBadge', {
                    originalWidth: img.originalWidth ?? 0,
                    finalWidth: img.finalWidth ?? 0,
                    originalBytes: typeof img.originalBytes === 'number' ? formatFileSize(img.originalBytes) : '',
                    finalBytes: typeof img.finalBytes === 'number' ? formatFileSize(img.finalBytes) : '',
                  })}
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-3">
              {/* 유나 §17 PASS 권고①(2026-09-06) — 반복 조작(위/아래 이동)과
                  되돌리기 비싼 조작(삭제)을 같은 gap-1 묶음에 안 둔다. 두 그룹
                  사이 gap-3로 시각 분리. */}
              <div className="flex gap-1">
                <Button
                  type="button" variant="outline" size="sm" disabled={disabled || index === 0}
                  onClick={() => onReorder(index, index - 1)}
                  data-testid="channel-post-image-attachment-move-up"
                  aria-label={t('channelPostsImageMoveUpAction', { position: index + 1 })}
                >
                  ↑
                </Button>
                <Button
                  type="button" variant="outline" size="sm" disabled={disabled || index === images.length - 1}
                  onClick={() => onReorder(index, index + 1)}
                  data-testid="channel-post-image-attachment-move-down"
                  aria-label={t('channelPostsImageMoveDownAction', { position: index + 1 })}
                >
                  ↓
                </Button>
              </div>
              {/* 유나 §17 PASS 권고② 정정(2026-09-06) — aria-label을 지우지 않고
                  N개 버튼이 "몇 번째 이미지"인지 지도록 위치를 붙인다(스크린리더가
                  「삭제」「삭제」만 반복해 듣는 문제 — §17-20① "지우지 마라"는 접근성
                  이름에 보이는 글자를 빼라는 뜻이지 덧붙이지 말라는 뜻이 아니다). */}
              <Button
                type="button" variant="outline" size="sm" disabled={disabled}
                onClick={() => onDelete(index)}
                data-testid="channel-post-image-attachment-delete"
                aria-label={t('channelPostsImageRemoveActionLabel', { position: index + 1 })}
              >
                {t('channelPostsImageRemoveAction')}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
