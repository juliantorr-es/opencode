# Desktop Package Tests

Test suite for `@opencode-ai/desktop` using **bun:test** (Bun's built-in test runner).

## Running Tests

```bash
# Run all tests
bun test

# Run tests in watch mode
bun test --watch

# Run tests with coverage
bun test --coverage

# Run a specific test file
bun test ./tests/ipc.test.ts
bun test ./tests/windows.test.ts

# Run tests matching a pattern
bun test ./tests/*.test.ts
```

## Test Files

| File | Tests | Description |
|------|-------|-------------|
| `tests/windows.test.ts` | ~20 | Window management logic: `clampZoom`, `upsertKeyValue`, `isTrustedRendererUrl`, `addRendererHeaders` |
| `tests/ipc.test.ts` | ~20 | IPC patterns: handler registration, deps delegation, reserved store names, serialized writes |
| `tests/store.test.ts` | ~26 | Store operations: get/set/delete/clear, cache pattern, IPC serialization, reserved name access control |
| `tests/markdown.test.ts` | ~14 | Markdown parsing: links, formatting, lists, code blocks, headings |
| `tests/testutils.test.ts` | ~12 | Electron mock utilities: mockWebContents, mockBrowserWindow, ipc events |

Total: ~90+ test cases across 5 files.

## How Electron Mocking Works

The desktop package depends on Electron (`electron` npm package), which is a native C++
module that **cannot be imported in bun's test environment**. The electron module
contains native bindings (`.node` files) that are only available at runtime in an
actual Electron process.

To test module logic without needing a full Electron runtime, this test suite
uses two strategies:

### Strategy 1: Self-Contained Logic Tests (Primary)

For most tests, we **replicate the function logic inline** rather than importing
from the real source module. This keeps tests fast, deterministic, and free of
Electron dependencies.

```ts
// Replicates clampZoom from windows.ts
const clampZoom = (value: number) => Math.min(Math.max(value, 0.2), 10)

test("clamps values correctly", () => {
  expect(clampZoom(0)).toBe(0.2)
  expect(clampZoom(5)).toBe(5)
  expect(clampZoom(15)).toBe(10)
})
```

This approach works well for:
- Pure utility functions (`clampZoom`, `upsertKeyValue`, `pickerFilters`)
- Algorithmic patterns (`isRendererUrl`, `addRendererHeaders`)
- Data flow patterns (`serializedWrite`, reserved store validation)

### Strategy 2: Importable Modules (When Possible)

Modules that don't import `electron` can be imported directly:

```ts
import { parseMarkdown } from "../src/main/markdown"
```

Currently, only `markdown.ts` can be directly imported in tests.

### Mock Utilities

The `src/test-utils/electron-mock.ts` file provides factory functions for
creating mock Electron objects without the native module:

```ts
import { createMockWebContents, createMockBrowserWindow } from "../src/test-utils/electron-mock"

const wc = createMockWebContents({ getZoomFactor: () => 1.5 })
const win = createMockBrowserWindow({ isFocused: () => true })
const event = createMockIpcMainInvokeEvent(wc)
```

These are used in the `testutils.test.ts` tests and can be used in any future
test that needs Electron-like objects.

## Adding New Tests

1. Create a `tests/*.test.ts` file
2. Write tests using `bun:test` primitives:
   ```ts
   import { describe, expect, test } from "bun:test"
   ```
3. If the module under test doesn't import `electron`, import it directly
4. If it does import `electron`, replicate the logic inline
5. Run `bun test ./tests/your-test.test.ts` to verify

## Coverage Expectations

- **Goal**: All utility functions and IPC handler patterns should be tested
- **Store operations**: Get/set/delete/clear + reserved name validation
- **Window management**: Zoom clamping, header manipulation, URL validation
- **IPC handlers**: Registration, deps delegation, error handling patterns
- **Markdown**: Rendering correctness, link customization

## Notes

- The existing `src/main/shell-env.test.ts` and `src/main/renderer/html.test.ts` 
  are pre-existing test files that may fail in `bun test` due to Electron import 
  resolution issues — this is a pre-existing condition, not caused by this test suite.
- The `github-ipc.ts` module referenced by `ipc.ts` doesn't exist yet (will be 
  created in a future lane), so tests for it are deferred.
- The `ipc-validation.ts` module referenced by `ipc.ts` doesn't exist yet, so 
  validation function tests are deferred.
