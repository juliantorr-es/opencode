export function pluralize(locale: string): (count: number) => Intl.LDMLPluralRule {
  const rules = new Intl.PluralRules(locale)
  return (count: number) => rules.select(count)
}

export function tPlural(
  t: (key: string, params?: Record<string, string | number | boolean>) => string,
  key: string,
  count: number,
  locale: string,
): string {
  const rule = pluralize(locale)(count)
  return t(`${key}.${rule}`, { count })
}
