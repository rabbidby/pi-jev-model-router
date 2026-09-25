import assert from "node:assert/strict";
import test from "node:test";
import {
  dayKey,
  emptyLedger,
  monthKey,
  recordCost,
  recordJevUsage,
  spendSnapshot,
} from "../extensions/pi-jev-model-router/budget";

test("costs are accumulated by UTC day, month, and model", () => {
  const ledger = emptyLedger();

  recordCost(ledger, "openai-codex/gpt-standard", 0.12345);
  recordCost(ledger, "openai-codex/gpt-standard", 0.1);
  recordCost(ledger, "openai-codex/gpt-premium", 0.5);

  assert.deepEqual(ledger.days[dayKey()], {
    total: 0.7235,
    byModel: {
      "openai-codex/gpt-standard": 0.2235,
      "openai-codex/gpt-premium": 0.5,
    },
  });
  assert.equal(ledger.months[monthKey()]?.total, 0.7235);
});

test("invalid costs are ignored and Jev usage is counted separately", () => {
  const ledger = emptyLedger();

  recordCost(ledger, "test/model", Number.NaN);
  recordCost(ledger, "test/model", -1);
  recordJevUsage(ledger, 12, 3);

  assert.equal(ledger.days[dayKey()], undefined);
  assert.deepEqual(ledger.jev, { requests: 1, inputTokens: 12, outputTokens: 3 });
});

test("budget pressure uses the most constrained configured cap", () => {
  const ledger = emptyLedger();
  ledger.days[dayKey()] = { total: 7, byModel: {} };
  ledger.months[monthKey()] = { total: 40, byModel: {} };

  const snapshot = spendSnapshot(ledger, {
    dailyUsd: 10,
    monthlyUsd: 100,
    softRatio: 0.7,
    hardRatio: 0.9,
  });

  assert.deepEqual(snapshot, {
    today: 7,
    month: 40,
    pressure: 0.7,
    dailyCap: 10,
    monthlyCap: 100,
  });
});
