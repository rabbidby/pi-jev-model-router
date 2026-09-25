import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  dayKey,
  emptyLedger,
  loadLedger,
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
    bySession: {},
  });
  assert.equal(ledger.months[monthKey()]?.total, 0.7235);
});

test("invalid costs are ignored and Jev usage is counted separately", () => {
  const ledger = emptyLedger();

  recordCost(ledger, "test/model", Number.NaN);
  recordCost(ledger, "test/model", -1);
  recordJevUsage(ledger, 12, 3);

  assert.equal(ledger.days[dayKey()], undefined);
  assert.deepEqual(ledger.jev, {
    requests: 1,
    inputTokens: 12,
    outputTokens: 3,
    bySession: {},
  });
});

test("cost and Jev usage are attributed to their session", () => {
  const ledger = emptyLedger();

  recordCost(ledger, "openai-codex/gpt-standard", 0.25, "session-a");
  recordJevUsage(ledger, 12, 3, "session-a");

  assert.deepEqual(ledger.days[dayKey()]?.bySession["session-a"], {
    total: 0.25,
    byModel: { "openai-codex/gpt-standard": 0.25 },
  });
  assert.deepEqual(ledger.months[monthKey()]?.bySession["session-a"], {
    total: 0.25,
    byModel: { "openai-codex/gpt-standard": 0.25 },
  });
  assert.deepEqual(ledger.jev.bySession["session-a"], {
    requests: 1,
    inputTokens: 12,
    outputTokens: 3,
  });
});

test("concurrent process updates preserve every session delta", async () => {
  const root = mkdtempSync(join(tmpdir(), "jev-ledger-concurrency-"));
  const file = join(root, "ledger.json");
  const worker = fileURLToPath(new URL("./fixtures/ledger-worker.ts", import.meta.url));
  const runWorker = (sessionId: string) => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", worker, file, sessionId, "10"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ledger worker exited ${code}: ${stderr}`));
    });
  });
  try {
    await Promise.all([runWorker("session-0"), runWorker("session-1")]);

    const ledger = loadLedger(file);
    assert.equal(ledger.days[dayKey()]?.total, 2);
    assert.equal(ledger.days[dayKey()]?.bySession["session-0"]?.total, 1);
    assert.equal(ledger.days[dayKey()]?.bySession["session-1"]?.total, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loading a v1 ledger preserves aggregates and initializes session attribution", () => {
  const root = mkdtempSync(join(tmpdir(), "jev-ledger-migration-"));
  const file = join(root, "ledger.json");
  try {
    writeFileSync(file, JSON.stringify({
      version: 1,
      days: { "2026-01-02": { total: 1.5, byModel: { "test/model": 1.5 } } },
      months: { "2026-01": { total: 1.5, byModel: { "test/model": 1.5 } } },
      jev: { requests: 2, inputTokens: 10, outputTokens: 4 },
      updatedAt: "2026-01-02T00:00:00.000Z",
    }));

    const ledger = loadLedger(file);
    assert.equal(ledger.version, 2);
    assert.equal(ledger.days["2026-01-02"]?.total, 1.5);
    assert.deepEqual(ledger.days["2026-01-02"]?.bySession, {});
    assert.deepEqual(ledger.jev.bySession, {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("budget pressure uses the most constrained configured cap", () => {
  const ledger = emptyLedger();
  ledger.days[dayKey()] = { total: 7, byModel: {}, bySession: {} };
  ledger.months[monthKey()] = { total: 40, byModel: {}, bySession: {} };

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
