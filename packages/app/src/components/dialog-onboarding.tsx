import { createSignal } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Splash } from "@opencode-ai/ui/logo"
import { Icon } from "@opencode-ai/ui/icon"
import { useSettings } from "@/context/settings"

export function DialogOnboarding(props: { startAt?: number }) {
  const dialog = useDialog()
  const settings = useSettings()
  const [index, setIndex] = createSignal(props.startAt ?? 0)

  const total = 4
  const last = () => total - 1
  const isFirst = () => index() === 0
  const isLast = () => index() >= last()

  function handleNext() {
    if (isLast()) return
    setIndex(index() + 1)
  }

  function handleFinish() {
    settings.general.setOnboarded(true)
    dialog.close()
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (!isLast() && e.key === "ArrowRight") {
      e.preventDefault()
      setIndex(index() + 1)
      return
    }
    if (!isFirst() && e.key === "ArrowLeft") {
      e.preventDefault()
      setIndex(index() - 1)
    }
  }

  const providers = [
    { id: "openai", name: "OpenAI", description: "GPT models for code generation and analysis" },
    { id: "anthropic", name: "Anthropic", description: "Claude models for complex reasoning tasks" },
    { id: "google", name: "Google", description: "Gemini models for multimodal AI" },
    { id: "groq", name: "Groq", description: "Fast inference with open models" },
    {
      id: "github-copilot",
      name: "GitHub Copilot",
      description: "AI pair programmer integrated with GitHub",
    },
    { id: "openrouter", name: "OpenRouter", description: "Access multiple models through one API" },
  ]

  let dead = false
  let nextStep = 0

  function handleConnectProvider(id: string) {
    nextStep = 2
    dead = true
    void import("./dialog-connect-provider").then((x) => {
      if (dead) return
      dialog.show(() => <x.DialogConnectProvider provider={id} />, () => {
        setTimeout(() => {
          if (dead) return
          dialog.show(() => <DialogOnboarding startAt={nextStep} />)
        }, 300)
      })
    })
  }

  return (
    <Dialog
      size="large"
      fit
      class="w-[min(calc(100vw-40px),720px)] h-[min(calc(100vh-40px),500px)] -mt-20 min-h-0 overflow-hidden"
    >
      <div class="flex flex-1 min-w-0 min-h-0" tabIndex={0} autofocus onKeyDown={handleKeyDown}>
        <div class="flex flex-col flex-1 min-w-0 p-8">
          {/* Step 0 — Welcome */}
          {index() === 0 && (
            <div class="flex flex-col items-center justify-center flex-1 gap-4">
              <Splash class="w-20 h-24" />
              <h1 class="text-24-medium text-text-strong">Welcome to OpenCode</h1>
              <p class="text-14-regular text-text-base text-center max-w-sm">
                Your AI-powered coding assistant. OpenCode helps you write, refactor, and understand code faster.
              </p>
              <Button variant="primary" size="large" onClick={handleNext} class="mt-4">
                Get Started
              </Button>
            </div>
          )}

          {/* Step 1 — Connect a Provider */}
          {index() === 1 && (
            <div class="flex flex-col flex-1 gap-4">
              <h1 class="text-20-medium text-text-strong">Connect your AI provider</h1>
              <p class="text-14-regular text-text-base">
                Choose a provider to get started. You can always add more later.
              </p>
              <div class="grid grid-cols-2 gap-3 mt-2">
                {providers.map((provider) => (
                  <button
                    type="button"
                    class="flex flex-col items-start gap-1 p-4 rounded-xl bg-surface-base hover:bg-surface-hover border border-border-weaker-base cursor-pointer text-left transition-colors"
                    onClick={() => handleConnectProvider(provider.id)}
                  >
                    <span class="text-14-medium text-text-strong">{provider.name}</span>
                    <span class="text-12-regular text-text-weak">{provider.description}</span>
                  </button>
                ))}
              </div>
              <div class="flex items-center justify-center gap-4">
                <button
                  type="button"
                  class="text-14-regular text-text-weak hover:text-text-base cursor-pointer bg-transparent border-none underline"
                  onClick={() => setIndex(2)}
                >
                  Skip for now
                </button>
              </div>
            </div>
          )}

          {/* Step 2 — Quick Tips */}
          {index() === 2 && (
            <div class="flex flex-col flex-1 gap-4">
              <h1 class="text-20-medium text-text-strong">Here are some quick tips</h1>
              <p class="text-14-regular text-text-base">Things to help you get started</p>
              <div class="flex flex-col gap-4 mt-2 flex-1">
                <div class="flex items-start gap-3">
                  <div class="size-8 rounded-lg bg-surface-base flex items-center justify-center shrink-0">
                    <Icon name="folder" size="small" />
                  </div>
                  <div>
                    <div class="text-14-medium text-text-strong">Open a project</div>
                    <div class="text-12-regular text-text-weak">Open a codebase to start working with OpenCode</div>
                  </div>
                </div>
                <div class="flex items-start gap-3">
                  <div class="size-8 rounded-lg bg-surface-base flex items-center justify-center shrink-0">
                    <Icon name="keyboard" size="small" />
                  </div>
                  <div>
                    <div class="text-14-medium text-text-strong">Use the command palette</div>
                    <div class="text-12-regular text-text-weak">Press Cmd+K to quickly access commands</div>
                  </div>
                </div>
                <div class="flex items-start gap-3">
                  <div class="size-8 rounded-lg bg-surface-base flex items-center justify-center shrink-0">
                    <Icon name="branch" size="small" />
                  </div>
                  <div>
                    <div class="text-14-medium text-text-strong">Switch agents</div>
                    <div class="text-12-regular text-text-weak">Press Tab to switch between build and plan agents</div>
                  </div>
                </div>
                <div class="flex items-start gap-3">
                  <div class="size-8 rounded-lg bg-surface-base flex items-center justify-center shrink-0">
                    <Icon name="help" size="small" />
                  </div>
                  <div>
                    <div class="text-14-medium text-text-strong">Ask questions</div>
                    <div class="text-12-regular text-text-weak">Select code and ask questions about it</div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Step 3 — You're Ready! */}
          {index() === 3 && (
            <div class="flex flex-col items-center justify-center flex-1 gap-4">
              <div class="size-16 rounded-full bg-accent-base flex items-center justify-center">
                <Icon name="check" class="text-icon-on-accent" size="large" />
              </div>
              <h1 class="text-24-medium text-text-strong">You're all set!</h1>
              <p class="text-14-regular text-text-base text-center max-w-sm">
                Start a new session, open a project, or explore the interface.
              </p>
            </div>
          )}

          {/* Spacer */}
          <div class="flex-1" />

          {/* Bottom section — buttons and step indicators */}
          <div class="flex flex-col gap-12">
            <div class="flex flex-col items-start gap-3">
              {index() === 2 && (
                <Button variant="primary" size="large" onClick={handleNext}>
                  Next
                </Button>
              )}
              {index() === 3 && (
                <Button variant="primary" size="large" onClick={handleFinish}>
                  Start coding
                </Button>
              )}
            </div>

            {/* Step indicator dots */}
            <div class="flex items-center gap-1.5 -my-2.5">
              {Array.from({ length: total }).map((_, i) => (
                <button
                  type="button"
                  class="h-6 flex items-center cursor-pointer bg-transparent border-none p-0 transition-all duration-200"
                  classList={{
                    "w-8": i === index(),
                    "w-3": i !== index(),
                  }}
                  onClick={() => setIndex(i)}
                >
                  <div
                    class="w-full h-0.5 rounded-[1px] transition-colors duration-200"
                    classList={{
                      "bg-icon-strong-base": i <= index(),
                      "bg-icon-weak-base": i > index(),
                    }}
                  />
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </Dialog>
  )
}
