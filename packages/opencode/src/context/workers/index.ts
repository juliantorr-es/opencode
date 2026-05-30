import { Layer } from "effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { ContextInvalidationBus } from "../invalidation-bus"
import * as FileMemory from "../file-memory"
import * as ValidationContext from "../validation-context"
import { EventStore } from "../../event"
import * as DuckDB from "../../storage/db.duckdb"

import * as FileIndexWorker from "./file-index-worker"
import * as SummaryWorker from "./summary-worker"
import * as ValidationParserWorker from "./validation-parser-worker"
import * as DuckDBProjectionWorker from "./duckdb-projection-worker"
import * as CleanupWorker from "./cleanup-worker"

export { FileIndexWorker, SummaryWorker, ValidationParserWorker, DuckDBProjectionWorker, CleanupWorker }

export const startAllWorkers = Layer.mergeAll(
  FileIndexWorker.layer,
  SummaryWorker.layer,
  ValidationParserWorker.layer,
  DuckDBProjectionWorker.layer,
  CleanupWorker.layer,
)
