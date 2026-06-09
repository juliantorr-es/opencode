// AUTO-GENERATED from research/schemas/enums.v1.json — do not edit by hand.

export const RUN_GRADES = ["exploratory", "controlled", "claim_candidate", "archival", "legacy_provisional"] as const;
export type RunGrade = (typeof RUN_GRADES)[number];

export const INSTRUMENTATION_MODES = ["off", "minimal", "research_standard", "research_deep"] as const;
export type InstrumentationMode = (typeof INSTRUMENTATION_MODES)[number];

export const RESULT_CLASSIFICATIONS = ["promoted", "rejected", "deferred", "research_only", "inconclusive"] as const;
export type ResultClassification = (typeof RESULT_CLASSIFICATIONS)[number];
