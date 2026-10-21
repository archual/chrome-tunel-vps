import { describe, expect, it } from "vitest";
import { RuntimeFailureGate } from "../../extension/src/background/runtime-failures";

describe("RuntimeFailureGate", () => {
  it("suppresses runtime failures while a probe is active and applies them afterwards", () => {
    const gate = new RuntimeFailureGate();
    const applied: string[] = [];

    gate.beginProbe();
    gate.report(() => applied.push("during-probe"));
    expect(applied).toEqual([]);
    expect(gate.probeInProgress).toBe(true);

    gate.endProbe();
    gate.report(() => applied.push("after-probe"));
    expect(applied).toEqual(["after-probe"]);
    expect(gate.probeInProgress).toBe(false);
  });

  it("keeps suppressing failures until the probe result is fully published", async () => {
    const gate = new RuntimeFailureGate();
    const applied: string[] = [];

    gate.beginProbe();
    await (async () => {
      await Promise.resolve();
      gate.report(() => applied.push("during-publication"));
    })();
    gate.endProbe();
    gate.report(() => applied.push("after-publication"));

    expect(applied).toEqual(["after-publication"]);
  });
});
