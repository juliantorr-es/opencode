# Tribunus — Brand Strategy & Trademark Filing Guide

## Positioning

Tribunus is the control plane for agentic engineering. It coordinates hundreds of coding agents working concurrently in a single repository, with real-time visibility across an entire engineering team. Senior engineers manage trusted juniors and rookies through scoped authority. Every change is visible to every agent and every human. The platform evolves from single-developer macOS coordination toward a peer-to-peer, serverless, enterprise-grade software factory where entire teams spawn and orchestrate thousands of concurrent coding agents.

The name carries Latin weight: tribunus — the Roman officer who represented, protected, and commanded. It is distinctive, not generic, and carries zero "AI hype" association.

## Trademark Class Strategy

The primary collision risk is tribunus.ai, a fintech investor-relations platform. The risk is manageable because the goods/services are in entirely different industries, different channels of trade, and different consumer bases.

### Recommended USPTO Filing

File in two Nice classes:

**Class 9** — Downloadable software
> Downloadable computer software for coordinating and orchestrating multiple artificial intelligence coding agents within a shared software repository; downloadable computer software for real-time collaboration, change visibility, and scoped authority management across teams of software engineers using AI coding agents.

**Class 42** — Software as a Service (SaaS)
> Providing temporary use of non-downloadable cloud-based software for coordinating and orchestrating multiple artificial intelligence coding agents within a shared software repository; providing temporary use of non-downloadable cloud-based software for real-time collaboration, change visibility, and scoped authority management across teams of software engineers using AI coding agents; software development and engineering services for agentic workflow orchestration.

### Why Class 36 (fintech) is NOT needed

tribunus.ai operates in investor relations/fintech. Their trademark protection would center on Class 36 (financial services). Tribunus the devtool has zero financial services functionality. The goods are unrelated, the customers are different (software engineers vs. founders/investors), and the channels of trade are different (developer platforms/GitHub vs. investor portals/LinkedIn). This is the strongest case for coexistence under the DuPont likelihood-of-confusion factors.

### Defensive Strategy
1. File Class 9 and Class 42 now (use 1B intent-to-use if not yet shipping commercially).
2. Monitor tribunus.ai for any trademark filing — if they file in Class 9/42, oppose or negotiate a coexistence agreement.
3. Register `tribunus.dev` as the primary domain. tribunus.ai is a different TLD with a different audience — confusion risk is low.

### Specimen Guidance

For **Class 9**: screenshot of the macOS app download page at tribunus.dev/download, showing the TRIBUNUS mark, a description of the software, and a "Download for macOS" button. Must include visible URL and date.

For **Class 42**: screenshot of the tribunus.dev homepage showing the mark, a description of the cloud coordination service, and a "Sign In" or "Start Trial" button.

See [USPTO specimen guidelines](https://www.uspto.gov/trademarks/basics/trademark-specimen) for current requirements.

## Brand Voice: Engineering Credibility, Not AI Hype

The developer audience in 2026 is skeptical of AI marketing. Trust in AI-generated code accuracy is *declining*. The winning brands in this space — Linear, PlanetScale, Railway — built credibility by being technically authentic first and adding AI features as optional utilities second.

### Voice Principles

1. **Augmentation, not replacement.** Tribunus helps engineers manage agents. It does not replace engineers. The human is the tribune; the agents are the cohort.

2. **Transparency about limitations.** Acknowledge that AI agents produce bugs, need review, and require coordination. That's *why* Tribunus exists — to bring order to the chaos.

3. **Operational reality, not magic.** Every claim is measurable: number of agents coordinated, latency of change propagation, conflicts prevented. No "10x your team" abstractions.

4. **Clarity over cleverness.** Technical language that speaks directly to engineering pain points: merge conflicts between agents, codebase drift, scope boundaries, visibility gaps.

5. **Product-first, AI-second.** The product is a coordination platform. AI agents happen to be what it coordinates today. Tomorrow it coordinates humans, CI systems, review workflows, and agents — it's a factory floor, not an AI wrapper.

### Tagline Options

| Style | Tagline |
|-------|---------|
| Descriptive | The control plane for agentic engineering. |
| Benefit | Real-time coordination, gates, and evidence for coding agents. |
| Aspirational | Command the cohort. |
| Technical | Realtime agent orchestration. Scoped authority. Full visibility. |

For initial macOS release (single developer, multi-agent): "Command the cohort." Short, Roman-military resonance, implies authority and coordination.

For team/enterprise release: "The control plane for agentic engineering." Technical, precise, owns the category.

## Competitive Landscape

| Competitor | Category | Tribunus Difference |
|-----------|----------|-------------------|
| **Cursor** | AI IDE, single-agent autocomplete | Tribunus coordinates hundreds of agents simultaneously in one repo |
| **Windsurf/Devin** | Autonomous agent cloud VMs | Tribunus runs locally, peer-to-peer, no cloud dependency |
| **Claude Code** | Multi-agent via CLI hooks | Tribunus is a purpose-built coordination fabric with scoped authority |
| **Copilot Workspace** | Issue-to-PR hosted workflows | Tribunus is real-time, not request-response; team-first, not individual-first |

None of the existing platforms address the "hundreds of agents in the same repository at the same time" problem. This is Tribunus's category to define.

### Market Signal

The enterprise AI coding agent market is estimated at $9.8–11.0 billion annually (April 2026, per Gartner). Every major player is adding multi-agent orchestration. Tribunus positions at the intersection of agent orchestration + team coordination — a layer *above* the individual coding agents.

## Visual Identity Direction

Based on research of brands that successfully avoid "AI hype" aesthetics (Linear, PlanetScale, Railway):

- **Type**: Monospace-forward for technical credibility; clean sans-serif for UI. JetBrains Mono or similar for code surfaces.
- **Color palette**: Dark-first (developer default). Accent color should be distinctive — avoid the teal/blue/gradient sameness of current AI brands. Consider a warm copper/bronze (Roman tribune armor) or a deep amber/gold (authority, visibility).
- **Imagery**: Structural, not generative. Diagrams over stock photos. Architecture over "sparkles." If using illustration, lean Roman architectural motifs (columns, arches, aqueducts) as metaphors for infrastructure/foundation.
- **Logo**: The fasces (bundle of rods, Roman symbol of authority through unity) is too politically loaded. A stylized Roman standard (vexillum) or an abstracted cohort formation (multiple nodes under a single axis) would be cleaner. Avoid over-literal Roman imagery — keep it modern and technical.
- **No AI tropes**: No neural network diagrams, no glowing brains, no robot hands, no purple/pink gradients, no "sparkle" emoji, no "magic" language.

## Content & Marketing Strategy

### Phase 1 — macOS Single-Developer (Now)

- **One-page site** at tribunus.dev. Name, tagline, download button. Screenshot or short demo loop showing dozens of agents working concurrently in a real repo.
- **Documentation-first**: The main content is the docs. How to configure agent cohorts, scoped authority, change visibility, coordination backends. This is the product.
- **Blog post**: "What Happens When 100 AI Agents Edit the Same File" — technical deep-dive with real benchmarks, merge conflict rates, coordination overhead measurements. This is the kind of content Hacker News and r/programming will engage with.
- **GitHub**: Open-source the coordination fabric protocol/spec. The implementation can stay proprietary or source-available. The protocol being open is the trust signal.
- **No cold outreach. No "AI newsletter." No growth hacks.** Ship to technical early adopters who feel the pain of multi-agent chaos.

### Phase 2 — Team Coordination (Later)

- **Case study / benchmark**: "N developers × M agents = NM concurrent changes. Here's how coordination latency scales."
- **Comparison page**: Tribunus vs. running N Claude Code instances in parallel (the status quo).
- **Enterprise page**: Scoped authority, audit trail, change evidence, compliance-readiness. The Roman "tribune" metaphor maps directly to enterprise governance.
- **Conference talks**: Strange Loop, GOTO, QCon, LeadDev. Technical audiences, no marketing tracks.

### What to Avoid

- No "AI-powered" in headlines. It's a coordination platform.
- No "revolutionize" or "transform." Engineers see through it.
- No comparison to human teams ("like having 100 developers"). The agents are tools, not people.
- No "vibe coding" alignment. Tribunus is about structure, gates, evidence — the opposite of "vibe."
- No purple gradients, no sparkle emoji, no robot mascots.

## Immediate Actions (Priority Order)

1. **Register TRIBUNUS trademark** — Class 9 + Class 42, USPTO intent-to-use (1B). Use a trademark attorney (Gerben Law, Trama TM, or similar). Cost: ~$1,500–$2,500 including attorney fees.
2. **Publish tribunus.dev** — single page with logo, tagline, download link. Use this as your trademark specimen.
3. **Secure npm/pypi/homebrew** — publish placeholder packages to prevent squatting.
4. **Reserve social handles** — @tribunus on Bluesky, Mastodon, X/Twitter. Even if you don't use them yet.
5. **Invest in a strong mark** — a logo that communicates structure, authority, and coordination without Roman cosplay or AI tropes. Budget for a real identity designer who understands developer tools.
6. **Write the coordination benchmark post** — this is your launch content. Make it so technically rigorous that it stands on its own as a reference.

## References

- USPTO Trademark Basics: https://www.uspto.gov/trademarks/basics
- Nice Classification: Class 9 (software goods), Class 42 (software services)
- DuPont Factors for likelihood of confusion: _In re E. I. du Pont de Nemours & Co._, 476 F.2d 1357 (C.C.P.A. 1973)
- Linear brand approach: https://linear.app
- PlanetScale brand approach: https://planetscale.com
- Developer marketing best practices: draft.dev, posthog.com, heavybit.com/library
