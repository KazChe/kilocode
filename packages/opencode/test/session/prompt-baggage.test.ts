/**
 * Unit tests for the OTel turn-baggage helpers exported from session/prompt.ts.
 * See OTEL_INSTRUMENTATION_PLAN.md commit 7 for the rationale and the agent
 * iteration.type mapping.
 */

import { describe, expect, test } from "bun:test"
import { buildTurnBaggage, mapAgentToIterationType } from "../../src/session/prompt"

describe("mapAgentToIterationType", () => {
  test("maps each built-in agent to its iteration.type", () => {
    expect(mapAgentToIterationType("code")).toBe("code_react")
    expect(mapAgentToIterationType("plan")).toBe("plan_execute")
    expect(mapAgentToIterationType("explore")).toBe("tool_use")
    expect(mapAgentToIterationType("debug")).toBe("debug_react")
    expect(mapAgentToIterationType("orchestrator")).toBe("orchestrate")
    expect(mapAgentToIterationType("ask")).toBe("ask")
  })

  test("defaults unknown agents to react", () => {
    expect(mapAgentToIterationType("user-defined-thing")).toBe("react")
    expect(mapAgentToIterationType("")).toBe("react")
  })
})

describe("buildTurnBaggage", () => {
  test("sets only conversation.id when agent is undefined", () => {
    const bag = buildTurnBaggage({ sessionID: "ses_abc123" } as any)
    expect(bag.getEntry("gen_ai.conversation.id")?.value).toBe("ses_abc123")
    expect(bag.getEntry("gen_ai.agent.id")).toBeUndefined()
    expect(bag.getEntry("gen_ai.group.iteration.type")).toBeUndefined()
  })

  test("sets all three keys when agent is defined", () => {
    const bag = buildTurnBaggage({ sessionID: "ses_xyz", agent: "code" } as any)
    expect(bag.getEntry("gen_ai.conversation.id")?.value).toBe("ses_xyz")
    expect(bag.getEntry("gen_ai.agent.id")?.value).toBe("code")
    expect(bag.getEntry("gen_ai.group.iteration.type")?.value).toBe("code_react")
  })

  test("uses 'react' iteration.type for unknown agents", () => {
    const bag = buildTurnBaggage({ sessionID: "ses_xyz", agent: "custom-agent" } as any)
    expect(bag.getEntry("gen_ai.agent.id")?.value).toBe("custom-agent")
    expect(bag.getEntry("gen_ai.group.iteration.type")?.value).toBe("react")
  })
})
