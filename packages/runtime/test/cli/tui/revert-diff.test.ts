import { describe, expect, test } from "bun:test"
const getRevertDiffFiles = (..._args: any[]): Array<{ filename: string; additions: number; deletions: number }> => []

describe("revert diff", () => {
  test("prefers the actual file path over /dev/null for added and deleted files", () => {
    const files = getRevertDiffFiles(`diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..3b18e51
--- /dev/null
+++ b/new.txt
@@ -0,0 +1 @@
+new content
diff --git a/old.txt b/old.txt
deleted file mode 100644
index 3b18e51..0000000
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-old content
`)

    expect(files).toEqual([
      {
        filename: "new.txt",
        additions: 1,
        deletions: 0,
      },
      {
        filename: "old.txt",
        additions: 0,
        deletions: 1,
      },
    ])
  })
})
