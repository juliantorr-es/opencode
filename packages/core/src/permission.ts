export * as PermissionV2 from "./permission"

import { Schema } from "effect"
import { Wildcard } from "./util/wildcard"

export const Action = Schema.Literals(["allow", "deny", "ask"]).annotate({ identifier: "PermissionV2.Action" })
export type Action = typeof Action.Type

export const Rule = Schema.Struct({
  permission: Schema.String,
  pattern: Schema.String,
  action: Action,
}).annotate({ identifier: "PermissionV2.Rule" })
export type Rule = typeof Rule.Type

export const Ruleset = Schema.Array(Rule).annotate({ identifier: "PermissionV2.Ruleset" })
export type Ruleset = typeof Ruleset.Type

const EDIT_TOOLS = ["edit", "write", "apply_patch"]

export function evaluate(permission: string, pattern: string, ...rulesets: Ruleset[]): Rule {
  const flat = rulesets.flat()
  // Prefer exact permission match over wildcard match — a specific `tune: "deny"`
  // rule must take priority over a catch-all `*: "allow"` rule regardless of merge order.
  const exact = flat.findLast(
    (rule) => rule.permission === permission && Wildcard.match(pattern, rule.pattern),
  )
  if (exact) return exact
  return (
    flat.findLast((rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern)) ?? {
      action: "ask",
      permission,
      pattern: "*",
    }
  )
}

export function merge(...rulesets: Ruleset[]): Ruleset {
  return rulesets.flat()
}

export function disabled(tools: string[], ruleset: Ruleset): Set<string> {
  return new Set(
    tools.filter((tool) => {
      const permission = EDIT_TOOLS.includes(tool) ? "edit" : tool
      // Prefer exact permission match over wildcard — a specific `tune: "deny"`
      // must not be overridden by a catch-all `*: "allow"` from a later merge.
      const exact = ruleset.findLast((rule) => rule.permission === permission)
      const rule = exact ?? ruleset.findLast((rule) => Wildcard.match(permission, rule.permission))
      return rule?.pattern === "*" && rule.action === "deny"
    }),
  )
}
