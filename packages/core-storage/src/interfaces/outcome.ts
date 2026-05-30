export interface MetricDefinition {
  metric: string;
  source: 'internal_ops' | 'ga4' | 'manual';
  target: number;
  direction: 'up' | 'down';
}

export interface OutcomeResult {
  metric: string;
  target: number;
  actual: number;
  direction: 'up' | 'down';
  scored_at: string;
}
