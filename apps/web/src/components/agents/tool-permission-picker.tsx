'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Lock } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { SectionCard } from '@/components/ui/section-card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import {
  fetchToolsetCatalog,
  type ToolsetCatalog,
  type ToolsetGroup,
} from '@/lib/toolset-catalog';

/**
 * E-MCP-RIGHT S1 (2da32fbf) — 툴 권한 picker.
 * 관리자가 에이전트 API 키에 바인딩될 MCP 툴 권한을 그룹(묶음) 단위로 선택한다.
 *
 * - 선택 emit/저장 값 = BE 그룹키 그대로(stories·tasks…). UI 라벨만 i18n 번역, 값은 불변.
 * - core = 항상 허용(체크 불가). admin/destructive = "위험 작업" 격리 섹션(opt-in).
 * - 데이터 SSOT = BE `/api/v2/mcp/toolset-catalog`(미준비 시 임시 상수 폴백).
 */

const ADMIN_SCOPE = 'admin';

interface ToolPermissionPickerProps {
  /** 선택된 그룹키 배열(= api-key.scope 비-core 부분). admin 포함 가능. */
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}

/** 네이티브 체크박스 + indeterminate ref + a11y(aria-checked mixed). 신규 dep 없음. */
function GroupCheckbox({
  checked,
  indeterminate = false,
  disabled = false,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  onChange?: (checked: boolean) => void;
  ariaLabel: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      aria-checked={indeterminate ? 'mixed' : checked}
      aria-label={ariaLabel}
      onChange={(e) => onChange?.(e.target.checked)}
      className="h-4 w-4 shrink-0 cursor-pointer accent-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
    />
  );
}

function GroupRow({
  group,
  label,
  checked,
  disabled,
  onToggle,
}: {
  group: ToolsetGroup;
  label: string;
  checked: boolean;
  disabled?: boolean;
  onToggle?: (checked: boolean) => void;
}) {
  const t = useTranslations('agents');
  const [expanded, setExpanded] = useState(false);
  const toolCount = group.tools.length;
  return (
    <div className="rounded-md">
      <div className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted">
        <GroupCheckbox
          checked={checked}
          disabled={disabled}
          ariaLabel={label}
          onChange={onToggle}
        />
        <span className="flex-1 text-sm text-foreground">{label}</span>
        {toolCount > 0 && (
          <Badge variant="secondary" className="font-normal text-muted-foreground">
            {t('toolPermissions.toolCount', { count: toolCount })}
          </Badge>
        )}
        {toolCount > 0 && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-label={t('toolPermissions.expandTools', { group: label })}
            className="rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? 'rotate-180' : ''}`} />
          </button>
        )}
      </div>
      {expanded && toolCount > 0 && (
        <ul className="ml-9 mb-1 flex flex-wrap gap-1.5 px-2">
          {group.tools.map((tool) => (
            <li key={tool} className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
              {tool}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ToolPermissionPicker({ value, onChange, disabled }: ToolPermissionPickerProps) {
  const t = useTranslations('agents');
  const [catalog, setCatalog] = useState<ToolsetCatalog | null>(null);
  const [isFallback, setIsFallback] = useState(false);

  useEffect(() => {
    let active = true;
    void fetchToolsetCatalog().then(({ catalog: c, isFallback: fb }) => {
      if (!active) return;
      setCatalog(c);
      setIsFallback(fb);
    });
    return () => {
      active = false;
    };
  }, []);

  const { coreGroups, normalGroups, dangerGroups } = useMemo(() => {
    const groups = catalog?.groups ?? [];
    return {
      coreGroups: groups.filter((g) => g.is_core && !g.is_destructive),
      normalGroups: groups.filter((g) => !g.is_core && !g.is_destructive),
      dangerGroups: groups.filter((g) => g.is_destructive),
    };
  }, [catalog]);

  // 기본 선택 = 전체 비파괴 그룹(레거시 read/write=전체 비파괴 허용과 정합). destructive는 off.
  // 빈 scope는 BE에서 legacy=전체 허용으로 해석되므로, UI를 진실(전체 선택)로 명시 초기화한다.
  const didInit = useRef(false);
  useEffect(() => {
    if (didInit.current) return;
    if (normalGroups.length === 0) return;
    didInit.current = true;
    if (value.length === 0) onChange(normalGroups.map((g) => g.key));
  }, [normalGroups, value, onChange]);

  const label = (key: string): string => t(`toolPermissions.groups.${key}`);

  const selected = useMemo(() => new Set(value), [value]);

  const toggleGroup = (key: string, on: boolean) => {
    const next = new Set(value);
    if (on) next.add(key);
    else next.delete(key);
    onChange([...next]);
  };

  const selectedNormalCount = normalGroups.filter((g) => selected.has(g.key)).length;
  const allNormalSelected = normalGroups.length > 0 && selectedNormalCount === normalGroups.length;
  const someNormalSelected = selectedNormalCount > 0 && !allNormalSelected;

  const toggleAllNormal = (on: boolean) => {
    const next = new Set(value);
    for (const g of normalGroups) {
      if (on) next.add(g.key);
      else next.delete(g.key);
    }
    onChange([...next]);
  };

  if (!catalog) {
    return (
      <SectionCard className="p-4">
        <p className="text-sm text-muted-foreground">{t('toolPermissions.loading')}</p>
      </SectionCard>
    );
  }

  return (
    <div className="space-y-3">
      <SectionCard className="space-y-3 p-4">
        <div>
          <h4 className="text-sm font-semibold text-foreground">{t('toolPermissions.title')}</h4>
          <p className="text-xs text-muted-foreground">{t('toolPermissions.description')}</p>
        </div>

        {isFallback && (
          <Alert variant="warning">
            <AlertDescription className="text-xs">{t('toolPermissions.fallbackNotice')}</AlertDescription>
          </Alert>
        )}

        {/* Core — 항상 허용 잠금 행 */}
        {coreGroups.map((g) => (
          <div key={g.key} className="flex items-center gap-3 rounded-md bg-muted px-2 py-1.5">
            <GroupCheckbox checked disabled ariaLabel={label(g.key)} />
            <span className="flex-1 text-sm text-foreground">{t('toolPermissions.coreAlways')}</span>
            <Lock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          </div>
        ))}

        {/* 전체 그룹 마스터 행 */}
        <div className="flex items-center gap-3 border-y border-border px-2 py-1.5">
          <GroupCheckbox
            checked={allNormalSelected}
            indeterminate={someNormalSelected}
            disabled={disabled}
            ariaLabel={t('toolPermissions.selectAll')}
            onChange={toggleAllNormal}
          />
          <span className="flex-1 text-sm font-medium text-foreground">{t('toolPermissions.selectAll')}</span>
          <span className="text-xs text-muted-foreground">
            {t('toolPermissions.selectedCount', { count: selectedNormalCount, total: normalGroups.length })}
          </span>
        </div>

        {/* 비파괴 그룹 체크리스트 */}
        <div className="space-y-0.5">
          {normalGroups.map((g) => (
            <GroupRow
              key={g.key}
              group={g}
              label={label(g.key)}
              checked={selected.has(g.key)}
              disabled={disabled}
              onToggle={(on) => toggleGroup(g.key, on)}
            />
          ))}
        </div>

        {/* 선택 요약 */}
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          <span className="text-xs text-muted-foreground">{t('toolPermissions.selectedSummary')}</span>
          <Badge variant="secondary" className="text-muted-foreground">{label('core')}</Badge>
          {normalGroups.filter((g) => selected.has(g.key)).map((g) => (
            <Badge key={g.key} className="bg-brand/15 text-brand">{label(g.key)}</Badge>
          ))}
          {selected.has(ADMIN_SCOPE) && (
            <Badge className="border-destructive text-destructive" variant="outline">{label('admin')}</Badge>
          )}
        </div>
      </SectionCard>

      {/* 위험 작업 격리 섹션 */}
      {dangerGroups.length > 0 && (
        <SectionCard className="space-y-3 p-4">
          <Alert variant="warning">
            <AlertTitle className="flex items-center gap-2 text-sm">
              {t('toolPermissions.dangerTitle')}
              <Badge variant="outline" className="font-normal">{t('toolPermissions.optIn')}</Badge>
            </AlertTitle>
            <AlertDescription className="text-xs">{t('toolPermissions.dangerDesc')}</AlertDescription>
          </Alert>
          {dangerGroups.map((g) => (
            <GroupRow
              key={g.key}
              group={g}
              label={label(g.key)}
              checked={selected.has(g.key)}
              disabled={disabled}
              onToggle={(on) => toggleGroup(g.key, on)}
            />
          ))}
        </SectionCard>
      )}
    </div>
  );
}
