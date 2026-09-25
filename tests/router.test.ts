import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG, type JevRouterConfig } from "../extensions/pi-jev-model-router/config";
import type { RouteAnalysis } from "../extensions/pi-jev-model-router/jev";
import { decide, findModel, type AvailableModel } from "../extensions/pi-jev-model-router/router";

const spend = { today: 0, month: 0, pressure: 0 };

function config(): JevRouterConfig {
  const value = structuredClone(DEFAULT_CONFIG);
  value.kindModels = {};
  value.kindMinimumTier = {};
  value.cache.aware = false;
  value.routes = { quick: [], standard: [], high: [], premium: [] };
  return value;
}

function analysis(score: number): RouteAnalysis {
  return {
    kind: "chat",
    kindConfidence: 1,
    kindProbabilities: { chat: 1 },
    complexity: score,
    complexityConfidence: 1,
    budgetIntensity: score,
    budgetIntensityConfidence: 1,
    deepReasoning: 0.5,
    latencyMs: 1,
  };
}

test("route targets match both provider and model id", () => {
  const direct = { provider: "openai-codex", id: "same-id" };
  const gateway = { provider: "openrouter", id: "same-id" };
  const target = { provider: "openai-codex", model: "same-id" };

  assert.equal(findModel([gateway], target), undefined);
  assert.equal(findModel([gateway, direct], target), direct);
});

test("a downward availability fallback reports the tier that supplied the model", () => {
  const value = config();
  value.routes.standard = [{ provider: "openai-codex", model: "gpt-standard" }];
  value.routes.high = [{ provider: "openai-codex", model: "unavailable" }];

  const decision = decide(analysis(2), value, {
    models: [{ provider: "openai-codex", id: "gpt-standard" }],
    spend,
  });

  assert.ok(decision);
  assert.equal(decision.tier, "standard");
  assert.equal(decision.tierIndex, 1);
  assert.equal(decision.downgraded, true);
  assert.deepEqual(decision.notes, ["high chain unavailable → standard"]);
});

test("decision trace records composition and every routing gate", () => {
  const value = config();
  value.routes.standard = [{ provider: "openai-codex", model: "unavailable-standard" }];
  value.routes.high = [{ provider: "openai-codex", model: "high-available" }];

  const decision = decide(analysis(3), value, {
    models: [{ provider: "openai-codex", id: "high-available" }],
    spend: { today: 10, month: 10, pressure: 1 },
  });

  assert.ok(decision);
  assert.equal(decision.desiredTier, "premium");
  assert.equal(decision.tier, "high");
  assert.equal(decision.downgraded, true);
  assert.deepEqual(decision.trace.composition, {
    weightedDemand: 3,
    reasoningAdjustment: 0,
    kindFloor: "quick",
    demand: 3,
    desiredTier: "premium",
  });
  assert.equal(decision.trace.selectedBy, "availability");
  assert.deepEqual(
    decision.trace.steps.map(({ gate, outcome, fromTier, toTier }) => ({
      gate,
      outcome,
      fromTier,
      toTier,
    })),
    [
      { gate: "confidence", outcome: "passed", fromTier: "premium", toTier: "premium" },
      { gate: "budget", outcome: "changed", fromTier: "premium", toTier: "standard" },
      { gate: "availability", outcome: "changed", fromTier: "standard", toTier: "high" },
      { gate: "cache", outcome: "passed", fromTier: "high", toTier: "high" },
    ],
  );
  assert.deepEqual(decision.notes, [
    "budget 100% of cap ($10.00 today) → capped at standard",
    "standard chain unavailable → high",
  ]);
});

test("a hard budget cap takes priority over prompt-cache retention", () => {
  const value = config();
  value.cache = { aware: true, deadband: 0.25, maxPenaltyUsd: 999, bypassTierDelta: 2 };
  value.routes.standard = [{ provider: "openai-codex", model: "gpt-standard" }];
  value.routes.premium = [{ provider: "openai-codex", model: "gpt-premium" }];

  const premium: AvailableModel = {
    provider: "openai-codex",
    id: "gpt-premium",
    cost: { input: 10, output: 0, cacheRead: 1, cacheWrite: 0 },
  };
  const decision = decide(
    { ...analysis(3), deepReasoning: 1 },
    value,
    {
      models: [
        {
          provider: "openai-codex",
          id: "gpt-standard",
          cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
        premium,
      ],
      spend: { today: 10, month: 10, pressure: 1 },
      contextTokens: 100_000,
      current: { index: 3, model: premium },
    },
  );

  assert.ok(decision);
  assert.equal(decision.tier, "standard");
  assert.equal(decision.downgraded, true);
  assert.equal(decision.held, undefined);
  assert.match(decision.notes.join("\n"), /capped at standard/);
  assert.doesNotMatch(decision.notes.join("\n"), /keeping the warm cache/);
});
