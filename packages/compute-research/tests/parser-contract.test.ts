/**
 * Parser-contract tests: verify parseStandardLayerEvents correctly parses
 * literal output lines from both Rust emitters.
 *
 * These tests catch field-order, regex, and phase-tracking mismatches
 * without requiring a 46-minute model run.
 */

import { test, expect } from "bun:test";

import { parseStandardLayerEvents } from "../src/parse/standard-layer-events"


