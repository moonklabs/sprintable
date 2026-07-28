'use client';

import { useRef, type ClipboardEvent, type KeyboardEvent } from 'react';
import { Hash } from 'lucide-react';
import { ENTITY_ICONS } from '@/components/chat/embed-card';
import { entityTypeLabel, getEntityQuery, type EntityResult } from '@/components/chat/chat-input-entity-tokens';
import { useEntityPicker } from '@/hooks/use-entity-picker';

interface EntityAwareTextareaProps {
  value: string;
  onChange: (next: string) => void;
  /** 후보 검색 스코프 — 없으면 `#` 트리거는 그대로 타이핑되고 피커는 안 뜬다(useEntityPicker
   * 자체가 projectId 없이는 검색을 안 걺). */
  projectId?: string;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  onPaste?: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
}

/**
 * story #2264(C-6) AC3 판정 대상 — 새 자리를 여는 «설정 한 줄». `#` 엔티티 피커가 필요한
 * 어떤 textarea든 이 컴포넌트로 바꾸기만 하면 된다(참조 코어 = chat-input-entity-tokens.ts +
 * use-entity-picker.ts, 이 파일은 그 위의 얇은 렌더 래퍼 — chat-input.tsx의 entity dropdown
 * JSX를 그대로 재사용). story description/AC(story-detail-panel.tsx)가 첫 소비자.
 */
export function EntityAwareTextarea({ value, onChange, projectId, placeholder, className, autoFocus, onPaste }: EntityAwareTextareaProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const entityPicker = useEntityPicker(projectId);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const nextValue = e.target.value;
    const cursorPos = e.target.selectionStart ?? nextValue.length;
    onChange(nextValue);
    const eq = getEntityQuery(nextValue, cursorPos);
    if (eq !== null) entityPicker.setEntityQuery(eq);
    else entityPicker.close();
  };

  const selectEntity = (entity: EntityResult) => {
    const textarea = textareaRef.current;
    const cursorPos = textarea?.selectionStart ?? value.length;
    const { text: nextText, caretPos } = entityPicker.selectAndApply(entity, value, cursorPos);
    onChange(nextText);
    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(caretPos, caretPos);
    });
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (entityPicker.entityResults.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); entityPicker.moveDown(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); entityPicker.moveUp(); return; }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      const ent = entityPicker.entityResults[entityPicker.entityIndex] ?? entityPicker.entityResults[0];
      if (ent) selectEntity(ent);
      return;
    }
    if (e.key === 'Escape') { entityPicker.close(); return; }
  };

  return (
    <div className="relative">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onPaste={onPaste}
        placeholder={placeholder}
        className={className}
        autoFocus={autoFocus}
      />
      {/* story #2263(C-5) ㉠㉡㉢ 그대로 재사용 — chat-input.tsx 엔티티 dropdown과 동형 렌더. */}
      {entityPicker.entityResults.length > 0 && (
        <ul role="listbox" aria-label="엔티티 후보" className="absolute left-0 z-50 mt-1 max-h-48 w-72 overflow-y-auto rounded-md border border-border bg-popover shadow-md">
          {entityPicker.entityResults.map((entity, idx) => {
            const EntityIcon = ENTITY_ICONS[entity.entity_type] ?? Hash;
            const isNewGroup = idx === 0 || entityPicker.entityResults[idx - 1]!.entity_type !== entity.entity_type;
            return (
              <li key={`${entity.entity_type}:${entity.entity_id}`}>
                {isNewGroup && (
                  <div className="sticky top-0 bg-popover px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {entityTypeLabel(entity.entity_type)}
                  </div>
                )}
                <button
                  type="button"
                  role="option"
                  aria-selected={idx === entityPicker.entityIndex}
                  onMouseDown={(e) => { e.preventDefault(); selectEntity(entity); }}
                  className={`flex w-full items-center px-3 py-2 text-left text-sm transition ${idx === entityPicker.entityIndex ? 'bg-accent text-foreground font-medium' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
                >
                  <EntityIcon className="mr-1.5 size-3.5 shrink-0" aria-hidden />
                  <span className="font-medium">{entity.title}</span>
                  {entity.status ? (
                    <span className="ml-2 rounded px-1.5 py-0.5 text-xs bg-muted text-muted-foreground">{entity.status}</span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
