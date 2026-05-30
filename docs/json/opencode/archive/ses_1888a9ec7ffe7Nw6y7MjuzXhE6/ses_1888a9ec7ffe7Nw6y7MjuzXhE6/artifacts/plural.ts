export function pluralize(locale: string): (count: number) => Intl.LDMLPluralRule {
  try {
    const rules = new Intl.PluralRules(locale)
    return (count: number) => rules.select(count)
  } catch {
    // Intl.PluralRules not available — fall back to "other"
    return () => "other" as Intl.LDMLPluralRule
  }
}

export function tPlural(
  t: (key: string, params?: Record<string, string | number | boolean>) => string,
  key: string,
  count: number,
  locale: string,
): string {
  const form = pluralize(locale)(count)
  // Try key.{one|other|few|many|two|zero} — t() handles missing keys gracefully
  return t(`${key}.${form}`, { count })
}
