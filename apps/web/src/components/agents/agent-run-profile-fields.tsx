'use client';

/**
 * story #4540 (E-DESKTOP-2 C-5) — the «실행» group: runtime · model · effort (명세 모음 C-5 · contract 20764ba3 v1.1).
 * One set of fields for one agent and for many: with many, every field starts «그대로 두기», and model · effort are offered
 * only when the chosen agents share a runtime (or a runtime is chosen for all of them).
 */
import { useId } from 'react';
import { useTranslations } from 'next-intl';
import { OperatorInput } from '@/components/ui/operator-control';
import { OperatorDropdownSelect } from '@/components/ui/operator-dropdown-select';
import {
  DESKTOP_RUNTIMES,
  EFFORT_LABEL_KEYS,
  effortsFor,
  keepEffortIfTaken,
  knownModels,
  modelNameOk,
  type RunProfileOptions,
} from '@/lib/agent-run-profile';

export const KEEP = '__keep__';
export const DEFAULT = '__default__';
export const CUSTOM = '__custom__';

export interface RunProfileDraft {
  runtime: string; // a runtime, or KEEP
  modelChoice: string; // KEEP · DEFAULT · CUSTOM · a listed name
  customModel: string;
  effort: string; // KEEP · DEFAULT · a value
}

const RUNTIME_LABELS: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };

/** The fields as they open: one agent shows what it has; many start «그대로 두기». */
export function initialDraft(
  options: RunProfileOptions | null,
  current: { runtime: string | null; model: string | null; effort: string | null } | null,
): RunProfileDraft {
  if (!current) return { runtime: KEEP, modelChoice: KEEP, customModel: '', effort: KEEP };
  const listed = options && current.runtime ? knownModels(options, current.runtime) : [];
  const modelChoice = current.model === null ? DEFAULT : listed.includes(current.model) ? current.model : CUSTOM;
  return {
    runtime: current.runtime ?? '',
    modelChoice,
    customModel: modelChoice === CUSTOM ? current.model ?? '' : '',
    effort: current.effort ?? DEFAULT,
  };
}

/** The runtime model · effort are judged against: the chosen one, or (kept) the one the agents already share. */
export function effectiveRuntime(draft: RunProfileDraft, shared: string | null): string | null {
  return draft.runtime === KEEP ? shared : draft.runtime;
}

function draftModel(draft: RunProfileDraft): string | null | undefined {
  if (draft.modelChoice === KEEP) return undefined;
  if (draft.modelChoice === DEFAULT) return null;
  if (draft.modelChoice === CUSTOM) return draft.customModel.trim();
  return draft.modelChoice;
}

/** A new runtime: model · effort go back to the defaults (the two CLIs' names differ — 명세 C-5). */
export function withRuntime(draft: RunProfileDraft, runtime: string, keepAllowed: boolean): RunProfileDraft {
  if (runtime === draft.runtime) return draft;
  const back = keepAllowed && runtime === KEEP ? KEEP : DEFAULT;
  return { runtime, modelChoice: back, customModel: '', effort: back };
}

/** A new model: an effort it doesn't take goes back to the default. */
export function withModel(draft: RunProfileDraft, modelChoice: string, options: RunProfileOptions, runtime: string | null): RunProfileDraft {
  const next = { ...draft, modelChoice };
  if (!runtime || next.effort === KEEP || next.effort === DEFAULT) return next;
  const model = draftModel(next);
  const efforts = effortsFor(options, runtime, model === undefined || model === '' ? null : model);
  return { ...next, effort: keepEffortIfTaken(efforts, next.effort) ?? DEFAULT };
}

/** The body for the server: `keep` for a field left as it is (many), null for the runtime's default. */
export function draftBody(draft: RunProfileDraft): { runtime: string; model: string | null; effort: string | null } {
  const model = draftModel(draft);
  return {
    runtime: draft.runtime === KEEP ? 'keep' : draft.runtime,
    model: model === undefined ? 'keep' : model,
    effort: draft.effort === KEEP ? 'keep' : draft.effort === DEFAULT ? null : draft.effort,
  };
}

/** Whether the draft can be sent: a typed-in name in the server's shape, and something actually chosen. */
export function draftReady(draft: RunProfileDraft, options: RunProfileOptions): boolean {
  if (draft.runtime === '') return false;
  if (draft.modelChoice === CUSTOM && !modelNameOk(options, draft.customModel.trim())) return false;
  return true;
}

interface FieldsProps {
  options: RunProfileOptions;
  draft: RunProfileDraft;
  onChange: (draft: RunProfileDraft) => void;
  /** many agents: «그대로 두기» in every field */
  keepAllowed?: boolean;
  /** many agents: the runtime they share (null when mixed) */
  sharedRuntime?: string | null;
  disabled?: boolean;
}

export function AgentRunProfileFields({ options, draft, onChange, keepAllowed = false, sharedRuntime = null, disabled = false }: FieldsProps) {
  const ta = useTranslations('agents');
  const ids = { runtime: useId(), model: useId(), effort: useId() };
  const runtime = effectiveRuntime(draft, sharedRuntime);
  const keepOption = keepAllowed ? [{ value: KEEP, label: ta('runProfileKeep') }] : [];

  const runtimeOptions = [
    ...keepOption,
    ...DESKTOP_RUNTIMES.map((r) => ({ value: r, label: RUNTIME_LABELS[r] })),
  ];
  const modelOptions = runtime
    ? [
        ...keepOption,
        { value: DEFAULT, label: ta('runProfileModelDefault') },
        ...knownModels(options, runtime).map((name) => ({ value: name, label: name })),
        { value: CUSTOM, label: ta('runProfileModelCustom') },
      ]
    : [];
  const model = draftModel(draft);
  const efforts = runtime ? effortsFor(options, runtime, model === undefined || model === '' ? null : model) : [];
  const effortOptions = [
    ...keepOption,
    { value: DEFAULT, label: ta('runProfileEffortDefault') },
    ...efforts.map((e) => ({ value: e, label: ta(EFFORT_LABEL_KEYS[e] ?? 'runProfileEffortDefault') })),
  ];
  const customBad = draft.modelChoice === CUSTOM && draft.customModel.trim() !== '' && !modelNameOk(options, draft.customModel.trim());

  return (
    <div className="space-y-3">
      <div className="grid gap-1.5 sm:grid-cols-[8rem_1fr] sm:items-center">
        <span id={ids.runtime} className="text-sm text-muted-foreground">{ta('runProfileRuntime')}</span>
        <OperatorDropdownSelect
          value={draft.runtime}
          onValueChange={(v) => onChange(withRuntime(draft, v, keepAllowed))}
          ariaLabelledBy={ids.runtime}
          options={runtimeOptions}
          placeholder={ta('runProfileRuntime')}
          disabled={disabled}
        />
      </div>
      {runtime ? (
        <>
          <div className="grid gap-1.5 sm:grid-cols-[8rem_1fr] sm:items-start">
            <span id={ids.model} className="text-sm text-muted-foreground sm:pt-2">{ta('runProfileModel')}</span>
            <div className="space-y-1.5">
              <OperatorDropdownSelect
                value={draft.modelChoice}
                onValueChange={(v) => onChange(withModel(draft, v, options, runtime))}
                ariaLabelledBy={ids.model}
                options={modelOptions}
                disabled={disabled}
              />
              {draft.modelChoice === CUSTOM ? (
                <>
                  <OperatorInput
                    value={draft.customModel}
                    onChange={(e) => onChange(withModel({ ...draft, customModel: e.target.value }, CUSTOM, options, runtime))}
                    aria-label={ta('runProfileModelCustom')}
                    aria-invalid={customBad || undefined}
                    disabled={disabled}
                  />
                  <p className="text-xs text-muted-foreground">
                    {customBad ? ta('runProfileModelCustomShape') : ta('runProfileModelCustomHint')}
                  </p>
                </>
              ) : null}
            </div>
          </div>
          <div className="grid gap-1.5 sm:grid-cols-[8rem_1fr] sm:items-center">
            <span id={ids.effort} className="text-sm text-muted-foreground">{ta('runProfileEffort')}</span>
            <div className="flex items-center gap-2">
              <OperatorDropdownSelect
                value={draft.effort}
                onValueChange={(v) => onChange({ ...draft, effort: v })}
                ariaLabelledBy={ids.effort}
                options={effortOptions}
                disabled={disabled}
                className="flex-1"
              />
              {draft.effort !== KEEP && draft.effort !== DEFAULT ? (
                <code className="shrink-0 text-xs text-muted-foreground">{draft.effort}</code>
              ) : null}
            </div>
          </div>
        </>
      ) : keepAllowed ? (
        <p className="text-xs text-muted-foreground">{ta('runProfileMixedLine')}</p>
      ) : null}
    </div>
  );
}
