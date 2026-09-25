import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { lock } from "proper-lockfile";
import type { BudgetConfig } from "./config";

export interface SpendBucket {
  total: number;
  byModel: Record<string, number>;
}

export interface LedgerBucket extends SpendBucket {
  bySession: Record<string, SpendBucket>;
}

export interface JevUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

export interface JevLedger extends JevUsage {
  bySession: Record<string, JevUsage>;
}

export interface Ledger {
  version: 2;
  days: Record<string, LedgerBucket>;
  months: Record<string, LedgerBucket>;
  jev: JevLedger;
  updatedAt: string;
}

export type LedgerUpdate =
  | { type: "cost"; modelKey: string; usd: number; sessionId?: string }
  | { type: "jev"; inputTokens?: number; outputTokens?: number; sessionId?: string };

export interface LedgerUpdateResult {
  ledger: Ledger;
  persisted: boolean;
  pendingUpdates: number;
  error?: string;
}

const pendingByFile = new Map<string, LedgerUpdate[]>();
const updateChains = new Map<string, Promise<LedgerUpdateResult>>();

export function emptyLedger(): Ledger {
  return {
    version: 2,
    days: {},
    months: {},
    jev: { requests: 0, inputTokens: 0, outputTokens: 0, bySession: {} },
    updatedAt: new Date().toISOString(),
  };
}

export function dayKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function monthKey(date = new Date()): string {
  return date.toISOString().slice(0, 7);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function numberRecord(value: unknown): Record<string, number> {
  return Object.fromEntries(
    Object.entries(asRecord(value))
      .filter((entry): entry is [string, number] =>
        typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] >= 0),
  );
}

function spendBucket(value: unknown): SpendBucket {
  const record = asRecord(value);
  return {
    total: nonNegativeNumber(record.total),
    byModel: numberRecord(record.byModel),
  };
}

function ledgerBucket(value: unknown): LedgerBucket {
  const record = asRecord(value);
  return {
    ...spendBucket(record),
    bySession: Object.fromEntries(
      Object.entries(asRecord(record.bySession)).map(([sessionId, bucket]) => [
        sessionId,
        spendBucket(bucket),
      ]),
    ),
  };
}

function bucketRecord(value: unknown): Record<string, LedgerBucket> {
  return Object.fromEntries(
    Object.entries(asRecord(value)).map(([key, bucket]) => [key, ledgerBucket(bucket)]),
  );
}

function jevUsage(value: unknown): JevUsage {
  const record = asRecord(value);
  return {
    requests: nonNegativeNumber(record.requests),
    inputTokens: nonNegativeNumber(record.inputTokens),
    outputTokens: nonNegativeNumber(record.outputTokens),
  };
}

function jevLedger(value: unknown): JevLedger {
  const record = asRecord(value);
  return {
    ...jevUsage(record),
    bySession: Object.fromEntries(
      Object.entries(asRecord(record.bySession)).map(([sessionId, usage]) => [
        sessionId,
        jevUsage(usage),
      ]),
    ),
  };
}

/** Load v1 or v2 data into the current v2 shape. */
export function loadLedger(file: string): Ledger {
  try {
    const parsed = asRecord(JSON.parse(readFileSync(file, "utf8")));
    return {
      version: 2,
      days: bucketRecord(parsed.days),
      months: bucketRecord(parsed.months),
      jev: jevLedger(parsed.jev),
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch {
    return emptyLedger();
  }
}

function addTo(bucket: SpendBucket, modelKey: string, usd: number): void {
  bucket.total = round4(bucket.total + usd);
  bucket.byModel[modelKey] = round4((bucket.byModel[modelKey] ?? 0) + usd);
}

export function recordCost(
  ledger: Ledger,
  modelKey: string,
  usd: number,
  sessionId?: string,
): void {
  if (!Number.isFinite(usd) || usd <= 0) return;
  const now = new Date();
  const day = dayKey(now);
  const month = monthKey(now);
  ledger.days[day] ??= { total: 0, byModel: {}, bySession: {} };
  ledger.months[month] ??= { total: 0, byModel: {}, bySession: {} };
  addTo(ledger.days[day], modelKey, usd);
  addTo(ledger.months[month], modelKey, usd);
  if (sessionId) {
    ledger.days[day].bySession[sessionId] ??= { total: 0, byModel: {} };
    ledger.months[month].bySession[sessionId] ??= { total: 0, byModel: {} };
    addTo(ledger.days[day].bySession[sessionId], modelKey, usd);
    addTo(ledger.months[month].bySession[sessionId], modelKey, usd);
  }
}

export function recordJevUsage(
  ledger: Ledger,
  inputTokens = 0,
  outputTokens = 0,
  sessionId?: string,
): void {
  const input = nonNegativeNumber(inputTokens);
  const output = nonNegativeNumber(outputTokens);
  ledger.jev.requests += 1;
  ledger.jev.inputTokens += input;
  ledger.jev.outputTokens += output;
  if (sessionId) {
    ledger.jev.bySession[sessionId] ??= { requests: 0, inputTokens: 0, outputTokens: 0 };
    ledger.jev.bySession[sessionId].requests += 1;
    ledger.jev.bySession[sessionId].inputTokens += input;
    ledger.jev.bySession[sessionId].outputTokens += output;
  }
}

function applyUpdate(ledger: Ledger, update: LedgerUpdate): void {
  if (update.type === "cost") {
    recordCost(ledger, update.modelKey, update.usd, update.sessionId);
  } else {
    recordJevUsage(ledger, update.inputTokens, update.outputTokens, update.sessionId);
  }
}

async function writeLedgerAtomically(file: string, ledger: Ledger): Promise<void> {
  ledger.updatedAt = new Date().toISOString();
  const temporary = join(
    dirname(file),
    `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function persistUpdates(
  file: string,
  update?: LedgerUpdate,
): Promise<LedgerUpdateResult> {
  const pending = pendingByFile.get(file) ?? [];
  const batch = update ? [...pending, update] : [...pending];
  if (batch.length === 0) {
    return { ledger: loadLedger(file), persisted: true, pendingUpdates: 0 };
  }

  let release: (() => Promise<void>) | undefined;
  let compromised: Error | undefined;
  try {
    await mkdir(dirname(file), { recursive: true });
    release = await lock(file, {
      realpath: false,
      stale: 10_000,
      update: 5_000,
      retries: { retries: 10, factor: 1.5, minTimeout: 10, maxTimeout: 250, randomize: true },
      onCompromised: (error) => {
        compromised = error;
      },
    });
    const ledger = loadLedger(file);
    for (const item of batch) applyUpdate(ledger, item);
    if (compromised) throw compromised;
    await writeLedgerAtomically(file, ledger);
    pendingByFile.delete(file);
    return { ledger, persisted: true, pendingUpdates: 0 };
  } catch (error) {
    pendingByFile.set(file, batch);
    const ledger = loadLedger(file);
    for (const item of batch) applyUpdate(ledger, item);
    return {
      ledger,
      persisted: false,
      pendingUpdates: batch.length,
      error: errorMessage(error),
    };
  } finally {
    await release?.().catch(() => {});
  }
}

function enqueuePersistence(
  file: string,
  update?: LedgerUpdate,
): Promise<LedgerUpdateResult> {
  const previous = updateChains.get(file);
  const result = previous
    ? previous.then(
        () => persistUpdates(file, update),
        () => persistUpdates(file, update),
      )
    : persistUpdates(file, update);
  updateChains.set(file, result);
  const clearChain = () => {
    if (updateChains.get(file) === result) updateChains.delete(file);
  };
  void result.then(clearChain, clearChain);
  return result;
}

/** Apply one delta to the latest ledger and queue it locally when persistence fails. */
export function updateLedger(file: string, update: LedgerUpdate): Promise<LedgerUpdateResult> {
  return enqueuePersistence(file, update);
}

/** Retry any deltas queued after an earlier persistence failure. */
export function flushLedger(file: string): Promise<LedgerUpdateResult> {
  return enqueuePersistence(file);
}

export interface SpendSnapshot {
  today: number;
  month: number;
  /** max(today/dailyCap, month/monthlyCap); 0 when no caps are configured. */
  pressure: number;
  dailyCap?: number;
  monthlyCap?: number;
}

export function spendSnapshot(ledger: Ledger, budget: BudgetConfig): SpendSnapshot {
  const today = ledger.days[dayKey()]?.total ?? 0;
  const month = ledger.months[monthKey()]?.total ?? 0;
  const ratios: number[] = [];
  if (budget.dailyUsd && budget.dailyUsd > 0) ratios.push(today / budget.dailyUsd);
  if (budget.monthlyUsd && budget.monthlyUsd > 0) ratios.push(month / budget.monthlyUsd);
  return {
    today,
    month,
    pressure: ratios.length > 0 ? Math.max(...ratios) : 0,
    dailyCap: budget.dailyUsd,
    monthlyCap: budget.monthlyUsd,
  };
}

export function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export function formatUsd(value: number): string {
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(4)}`;
}
