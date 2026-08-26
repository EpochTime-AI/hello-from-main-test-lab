import type { ConflictInspection } from "../adapters/git.js";

export type ScenarioTrace = {
  commandId: string;
  argv: readonly string[];
  outcome: string;
};
export type ScenarioStep = { name: string; run: () => Promise<unknown> };

export class ScenarioRunner {
  readonly trace: ScenarioTrace[] = [];
  async run(step: ScenarioStep): Promise<unknown> {
    try {
      const value = await step.run();
      this.trace.push({ commandId: step.name, argv: [], outcome: "succeeded" });
      return value;
    } catch (error) {
      this.trace.push({
        commandId: step.name,
        argv: [],
        outcome: error instanceof Error ? error.name : "failed",
      });
      throw error;
    }
  }
  static normalizeConflict(value: ConflictInspection): ConflictInspection {
    return value;
  }
}
