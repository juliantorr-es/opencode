import { describe, expect, test } from "bun:test"

// stubs for deleted modules
type FooterApi = any
type FooterEvent = any
type StreamCommit = any
const writeSessionOutput = {} as any

function footer() {
  const events: FooterEvent[] = []
  const commits: StreamCommit[] = []

  const api: FooterApi = {
    isClosed: false,
    onPrompt: () => () => {},
    onClose: () => () => {},
    event: (next: FooterEvent) => {
      events.push(next)
    },
    append: (next: StreamCommit) => {
      commits.push(next)
    },
    idle: () => Promise.resolve(),
    close: () => {},
    destroy: () => {},
  }

  return { api, events, commits }
}

describe("run stream bridge", () => {
  test("defaults status patches to running phase", () => {
    const out = footer()

    writeSessionOutput(
      {
        footer: out.api,
      },
      {
        commits: [],
        footer: {
          patch: {
            status: "assistant responding",
          },
        },
      },
    )

    expect(out.events).toEqual([
      {
        type: "stream.patch",
        patch: {
          phase: "running",
          status: "assistant responding",
        },
      },
    ])
  })
})
