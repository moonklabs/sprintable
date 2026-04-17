export function getMessageFallback(namespace: string, key: string) {
  return `${namespace}.${key}`;
}

export function formatLocaleDate(
  value: string | number | Date,
  locale?: string,
  options?: Intl.DateTimeFormatOptions,
) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const resolvedLocale = locale || 'en';

  try {
    return new Intl.DateTimeFormat(resolvedLocale, options).format(date);
  } catch {
    return new Intl.DateTimeFormat('en', options).format(date);
  }
}

export function formatLocaleDateTime(value: string | number | Date, locale?: string) {
  return formatLocaleDate(value, locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function formatLocaleDateOnly(value: string | number | Date, locale?: string) {
  return formatLocaleDate(value, locale, {
    dateStyle: 'medium',
  });
}
