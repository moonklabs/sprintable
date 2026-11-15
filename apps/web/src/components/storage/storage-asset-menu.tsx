'use client';

import { useTranslations } from 'next-intl';
import { MenuContent, MenuGroup, MenuItem, MenuLabel, MenuSeparator } from '@/components/ds/menu';
import type { Asset } from '@/lib/storage/types';

/**
 * 4910 — 자산 하나의 «메뉴 항목 목록» 한 곳. 목록 행의 ⋯ 메뉴 · 우클릭 메뉴, 격자 카드의 우클릭 메뉴가 모두 이 목록을 쓴다(열기 · 다운로드 · 삭제 — 있는 동작만, 새 동작 0).
 * 우클릭만으로 닿는 동작을 만들지 않는다: 폰 · 키보드에는 행의 ⋯ 단추와 상세 패널(다운로드 · 삭제)이 같은 동작을 준다.
 */
export function StorageAssetMenuContent({
  asset,
  onOpen,
  onDownload,
  onDelete,
  labelled = false,
}: {
  asset: Asset;
  onOpen: (asset: Asset) => void;
  onDownload: (asset: Asset) => void;
  onDelete: (asset: Asset) => void;
  /** ⋯ 단추 메뉴는 맨 위에 파일 이름을 적는다(어느 파일의 메뉴인가) — 우클릭 메뉴는 마우스가 이미 그 행 위라 생략. */
  labelled?: boolean;
}) {
  const t = useTranslations('storage');
  return (
    <MenuContent align="end">
      <MenuGroup>
        {labelled ? <MenuLabel className="max-w-[200px] truncate">{asset.name}</MenuLabel> : null}
        <MenuItem icon="open_in_full" onClick={() => onOpen(asset)}>{t('rowOpen')}</MenuItem>
        <MenuItem icon="download" onClick={() => onDownload(asset)}>{t('download')}</MenuItem>
      </MenuGroup>
      <MenuSeparator />
      <MenuItem icon="delete" variant="danger" onClick={() => onDelete(asset)}>{t('delete')}</MenuItem>
    </MenuContent>
  );
}
