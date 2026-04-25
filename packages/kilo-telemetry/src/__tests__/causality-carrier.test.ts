import { beforeEach, describe, expect, test } from "bun:test"
import { context } from "@opentelemetry/api"
import { CausalityCarrier } from "../causality-carrier.js"

describe("CausalityCarrier", () => {
  beforeEach(() => {
    CausalityCarrier.clear()
  })

  test("capture then extract returns the same Context", () => {
    const ctx = context.active()
    CausalityCarrier.capture("tc-1", ctx)
    expect(CausalityCarrier.extract("tc-1")).toBe(ctx)
  })

  test("extract auto-deletes on read", () => {
    CausalityCarrier.capture("tc-2", context.active())
    expect(CausalityCarrier.extract("tc-2")).toBeDefined()
    expect(CausalityCarrier.extract("tc-2")).toBeUndefined()
  })

  test("extract returns undefined for unknown tool call IDs", () => {
    expect(CausalityCarrier.extract("never-captured")).toBeUndefined()
  })

  test("clear empties the map", () => {
    CausalityCarrier.capture("tc-3", context.active())
    CausalityCarrier.capture("tc-4", context.active())
    expect(CausalityCarrier.size()).toBe(2)
    CausalityCarrier.clear()
    expect(CausalityCarrier.size()).toBe(0)
  })

  test("size reflects carrier count through capture and extract", () => {
    expect(CausalityCarrier.size()).toBe(0)
    CausalityCarrier.capture("tc-5", context.active())
    expect(CausalityCarrier.size()).toBe(1)
    CausalityCarrier.capture("tc-6", context.active())
    expect(CausalityCarrier.size()).toBe(2)
    CausalityCarrier.extract("tc-5")
    expect(CausalityCarrier.size()).toBe(1)
    CausalityCarrier.extract("tc-6")
    expect(CausalityCarrier.size()).toBe(0)
  })

  test("recapturing the same tool call ID overwrites the previous value", () => {
    // Edge case: same ID captured twice without extract between. Last writer wins.
    // Should not happen in normal flow (each tool call ID is unique per LLM
    // round) but worth pinning the behavior.
    const first = context.active()
    const second = context.active()
    CausalityCarrier.capture("tc-7", first)
    CausalityCarrier.capture("tc-7", second)
    expect(CausalityCarrier.size()).toBe(1)
    expect(CausalityCarrier.extract("tc-7")).toBe(second)
  })
})
