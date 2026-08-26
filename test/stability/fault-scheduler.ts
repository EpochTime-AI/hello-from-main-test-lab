export type MutationPhase = "before" | "after";
export type Fault = {
  mutation: string;
  phase: MutationPhase;
  kind: "unknownOutcome" | "responseLost" | "cancelled";
};

/** A deterministic test-only scheduler; it never delays or derives Core decisions. */
export class FaultScheduler {
  readonly effects: string[] = [];
  private readonly planned = new Map<string, Fault[]>();

  constructor(faults: readonly Fault[] = []) {
    for (const fault of faults) {
      const key = `${fault.mutation}:${fault.phase}`;
      this.planned.set(key, [...(this.planned.get(key) ?? []), fault]);
    }
  }

  async mutate<T>(name: string, operation: () => Promise<T>): Promise<T> {
    this.effects.push(`before:${name}`);
    this.throwPlanned(name, "before");
    const value = await operation();
    this.effects.push(`after:${name}`);
    this.throwPlanned(name, "after");
    return value;
  }

  wakeups(
    order: readonly ("duplicate" | "reordered" | "missed" | "normal")[],
  ): string[] {
    return order.flatMap((wakeup, index) =>
      wakeup === "missed"
        ? []
        : wakeup === "duplicate"
          ? [`wake:${index}`, `wake:${index}`]
          : [`wake:${index}`],
    );
  }

  private throwPlanned(name: string, phase: MutationPhase): void {
    const key = `${name}:${phase}`;
    const fault = this.planned.get(key)?.shift();
    if (!fault) return;
    throw new FaultInjectedError(fault);
  }
}

export class FaultInjectedError extends Error {
  constructor(readonly fault: Fault) {
    super(`${fault.kind} ${fault.phase} ${fault.mutation}`);
  }
}
