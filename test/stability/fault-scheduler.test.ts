import { describe, expect, test } from "vitest";
import { FaultInjectedError, FaultScheduler } from "./fault-scheduler.js";

describe("L4 deterministic fault scheduler", () => {
  test("injects faults before and after an external mutation without sleeps", async () => {
    const before = new FaultScheduler([
      { mutation: "push", phase: "before", kind: "cancelled" },
    ]);
    const after = new FaultScheduler([
      { mutation: "ready", phase: "after", kind: "responseLost" },
    ]);
    let mutations = 0;

    await expect(
      before.mutate("push", async () => ++mutations),
    ).rejects.toBeInstanceOf(FaultInjectedError);
    await expect(
      after.mutate("ready", async () => ++mutations),
    ).rejects.toBeInstanceOf(FaultInjectedError);

    expect(mutations).toBe(1);
    expect(before.effects).toEqual(["before:push"]);
    expect(after.effects).toEqual(["before:ready", "after:ready"]);
  });

  test("represents duplicate, reordered, and missed wakeups as scheduling evidence only", () => {
    const scheduler = new FaultScheduler();
    expect(
      scheduler.wakeups(["normal", "duplicate", "missed", "reordered"]),
    ).toEqual(["wake:0", "wake:1", "wake:1", "wake:3"]);
  });
});
