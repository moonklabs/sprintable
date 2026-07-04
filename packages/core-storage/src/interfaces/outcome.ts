export interface MetricDefinition {
  metric: string;
  source: 'internal_ops' | 'ga4' | 'manual';
  target: number;
  direction: 'up' | 'down';
  /** source==='ga4'일 때만 필수(BE _validate_metric_definition GA4 분기와 동기). */
  property_id?: string;
  ga4_metric?: string;
  date_range_days?: number;
}

export interface OutcomeResult {
  metric: string;
  target: number;
  actual: number;
  direction: 'up' | 'down';
  scored_at: string;
}
