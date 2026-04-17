export interface MonthlyAgentUsageSummary {
  active_agents: number;
  total_hours: number;
  total_tokens: number;
  total_cost_cents: number;
}

export interface MonthlyAgentUsageBreakdownRow {
  key: string;
  label: string;
  total_hours: number;
  total_tokens: number;
  total_cost_cents: number;
  run_count: number;
}

export type MonthlyAgentUsageBreakdownGroup = 'project' | 'agent' | 'model';

export interface MonthlyAgentUsageRunRow {
  project_id: string | null;
  agent_id: string | null;
  model: string | null;
  duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  computed_cost_cents: number | null;
}

export interface UsageMonthRange {
  month: string;
  monthStart: string;
  monthStartIso: string;
  nextMonthStartIso: string;
}

function roundUsageHours(hours: number) {
  return Math.round(hours * 100) / 100;
}

export function validateUsageMonth(month: string | null, now = new Date()): { ok: true; month: string; monthStart: string } | { ok: false; message: string } {
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return { ok: false, message: 'month must be in YYYY-MM format' };
  }

  const [yearStr, monthStr] = month.split('-');
  const year = Number(yearStr);
  const monthIndex = Number(monthStr);
  if (!Number.isInteger(year) || !Number.isInteger(monthIndex) || monthIndex < 1 || monthIndex > 12) {
    return { ok: false, message: 'month must be in YYYY-MM format' };
  }

  const requestedMonth = new Date(Date.UTC(year, monthIndex - 1, 1));
  const currentMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  if (requestedMonth.getTime() > currentMonth.getTime()) {
    return { ok: false, message: 'month cannot be in the future' };
  }

  return {
    ok: true,
    month,
    monthStart: requestedMonth.toISOString().slice(0, 10),
  };
}

export function getUsageMonthRange(month: string): UsageMonthRange {
  const [yearStr, monthStr] = month.split('-');
  const year = Number(yearStr);
  const monthIndex = Number(monthStr);
  const monthStart = new Date(Date.UTC(year, monthIndex - 1, 1));
  const nextMonthStart = new Date(Date.UTC(year, monthIndex, 1));

  return {
    month,
    monthStart: monthStart.toISOString().slice(0, 10),
    monthStartIso: monthStart.toISOString(),
    nextMonthStartIso: nextMonthStart.toISOString(),
  };
}

export function zeroMonthlyAgentUsageSummary(): MonthlyAgentUsageSummary {
  return {
    active_agents: 0,
    total_hours: 0,
    total_tokens: 0,
    total_cost_cents: 0,
  };
}

export function normalizeMonthlySummaryRow(row: Record<string, unknown> | Partial<MonthlyAgentUsageSummary> | null | undefined): MonthlyAgentUsageSummary {
  if (!row) return zeroMonthlyAgentUsageSummary();
  return {
    active_agents: Number(row.active_agents ?? 0),
    total_hours: Number(row.total_hours ?? 0),
    total_tokens: Number(row.total_tokens ?? 0),
    total_cost_cents: Number(row.total_cost_cents ?? 0),
  };
}

export function normalizeMonthlyBreakdownRows(rows: Array<Record<string, unknown> | Partial<MonthlyAgentUsageBreakdownRow>> | null | undefined): MonthlyAgentUsageBreakdownRow[] {
  return (rows ?? []).map((row) => ({
    key: String(row.key ?? ''),
    label: String(row.label ?? row.key ?? ''),
    total_hours: Number(row.total_hours ?? 0),
    total_tokens: Number(row.total_tokens ?? 0),
    total_cost_cents: Number(row.total_cost_cents ?? 0),
    run_count: Number(row.run_count ?? 0),
  }));
}

export function summarizeMonthlyUsageRows(rows: MonthlyAgentUsageRunRow[]): MonthlyAgentUsageSummary {
  const activeAgents = new Set(rows.map((row) => row.agent_id).filter(Boolean));
  const totalDurationMs = rows.reduce((sum, row) => sum + Number(row.duration_ms ?? 0), 0);
  const totalTokens = rows.reduce((sum, row) => sum + Number(row.input_tokens ?? 0) + Number(row.output_tokens ?? 0), 0);
  const totalCostCents = rows.reduce((sum, row) => sum + Number(row.computed_cost_cents ?? 0), 0);

  return {
    active_agents: activeAgents.size,
    total_hours: roundUsageHours(totalDurationMs / 3600000),
    total_tokens: totalTokens,
    total_cost_cents: totalCostCents,
  };
}

export function buildMonthlyUsageBreakdownRows(
  rows: MonthlyAgentUsageRunRow[],
  groupBy: MonthlyAgentUsageBreakdownGroup,
  lookup?: {
    projectNameById?: Record<string, string>;
    agentNameById?: Record<string, string>;
  },
): MonthlyAgentUsageBreakdownRow[] {
  const aggregates = new Map<string, MonthlyAgentUsageBreakdownRow & { duration_ms_total: number }>();

  const getKeyAndLabel = (row: MonthlyAgentUsageRunRow) => {
    if (groupBy === 'project') {
      const key = row.project_id ?? 'unknown-project';
      return {
        key,
        label: lookup?.projectNameById?.[key] ?? 'Unknown project',
      };
    }

    if (groupBy === 'agent') {
      const key = row.agent_id ?? 'unknown-agent';
      return {
        key,
        label: lookup?.agentNameById?.[key] ?? 'Unknown agent',
      };
    }

    const key = row.model?.trim() || 'unknown';
    return { key, label: key };
  };

  for (const row of rows) {
    const { key, label } = getKeyAndLabel(row);
    const current = aggregates.get(key) ?? {
      key,
      label,
      total_hours: 0,
      total_tokens: 0,
      total_cost_cents: 0,
      run_count: 0,
      duration_ms_total: 0,
    };

    current.duration_ms_total += Number(row.duration_ms ?? 0);
    current.total_tokens += Number(row.input_tokens ?? 0) + Number(row.output_tokens ?? 0);
    current.total_cost_cents += Number(row.computed_cost_cents ?? 0);
    current.run_count += 1;
    current.total_hours = roundUsageHours(current.duration_ms_total / 3600000);
    current.label = label;

    aggregates.set(key, current);
  }

  return [...aggregates.values()]
    .map((row) => ({
      key: row.key,
      label: row.label,
      total_hours: row.total_hours,
      total_tokens: row.total_tokens,
      total_cost_cents: row.total_cost_cents,
      run_count: row.run_count,
    }))
    .sort((a, b) => {
      if (b.total_cost_cents !== a.total_cost_cents) return b.total_cost_cents - a.total_cost_cents;
      if (b.total_tokens !== a.total_tokens) return b.total_tokens - a.total_tokens;
      return a.label.localeCompare(b.label);
    });
}

export function serializeMonthlyUsageBreakdownCsv(input: {
  month: string;
  groupBy: MonthlyAgentUsageBreakdownGroup;
  projectLabel: string;
  rows: MonthlyAgentUsageBreakdownRow[];
}): string {
  const escapeCsv = (value: string | number) => {
    const text = String(value);
    if (!/[",\n]/.test(text)) return text;
    return `"${text.replace(/"/g, '""')}"`;
  };

  const lines = [
    ['month', input.month],
    ['project', input.projectLabel],
    ['group_by', input.groupBy],
    [],
    ['key', 'label', 'total_hours', 'total_tokens', 'total_cost_cents', 'run_count'],
    ...input.rows.map((row) => [row.key, row.label, row.total_hours, row.total_tokens, row.total_cost_cents, row.run_count]),
  ];

  return `${lines
    .map((line) => line.map((cell) => escapeCsv(cell)).join(','))
    .join('\n')}\n`;
}
