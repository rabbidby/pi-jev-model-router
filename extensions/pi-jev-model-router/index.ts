/**
 * pi-jev-model-router — Jev model router for pi.
 *
 * On every user prompt: send the request to Jev through TypeSafe or OpenRouter,
 * get typed judgments about what the work is, how hard it is, and how much capability it
 * deserves, then route the turn to the matching model tier. Code applies the
 * budget policy; Jev only judges the task.
 *
 * Commands:  /jev-router [status|on|off|mode|budget|why|revert]
 *            /jev-route <text>
 * Tool:      jev_route
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { apiKeyFor, loadConfig, TIERS, type JevRouterConfig } from "./config";
import {
  flushLedger,
  formatUsd,
  loadLedger,
  spendSnapshot,
  updateLedger,
  type Ledger,
  type LedgerUpdateResult,
} from "./budget";
import { classifyRequest, JevError, type RouteAnalysis } from "./jev";
import {
  decide,
  describeDecision,
  firstAvailable,
  tierIndex,
  tierForModel,
  type AvailableModel,
  type Decision,
} from "./router";

interface Runtime {
  config: JevRouterConfig;
  ledger: Ledger;
  models: AvailableModel[];
  sessionId?: string;
  ledgerPersistenceFailed?: boolean;
  lastDecision?: Decision;
  lastAnalysis?: RouteAnalysis;
  lastPrompt?: string;
  previousModelKey?: string;
  appliedTierIndex?: number;
  lastEntrySignature?: string;
}

const ACK_PATTERN = /^(y|yes|yeah|yep|ok|okay|sure|continue|go on|go ahead|do it|proceed|nice|thanks|thank you|ty)[.!]?$/i;

/** Data rendered in the transcript for every routing decision (never sent to the LLM). */
interface DecisionEntry {
  action: "switched" | "kept" | "notified" | "skipped";
  tier: string;
  desiredTier?: string;
  model: string;
  kind: string;
  kindConfidence: number;
  complexity: number;
  capability: number;
  deepReasoning: number;
  demand: number;
  pressure: number;
  kindSpecialised?: boolean;
  reason: string;
  notes: string[];
  trace?: Decision["trace"];
  /** Set when the router deliberately did not consult Jev for this prompt. */
  skipReason?: string;
  at: number;
}

function appendEntry(data: DecisionEntry, runtime: Runtime): void {
  // `appendEntry` is optional across pi builds and forks.
  if (!api || typeof api.appendEntry !== "function") return;
  const signature = [
    data.action,
    data.skipReason ?? "",
    data.tier,
    data.model,
    data.reason,
    data.trace?.selectedBy ?? "",
    ...data.notes,
  ].join("|");
  if (runtime.lastEntrySignature === signature) return;
  runtime.lastEntrySignature = signature;
  try {
    api.appendEntry<DecisionEntry>("jev-router-decision", data);
  } catch {
    // Durable entries are a nice-to-have; never let them break routing.
  }
}

/** ctx.ui.notify is present in every documented mode, but forks vary. */
function notify(ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info"): void {
  try {
    ctx.ui?.notify?.(text, level);
  } catch {
    // Ignore UI failures.
  }
}

/** Status-bar updates are cosmetic and optional. */
function setStatus(ctx: ExtensionContext, text: string): void {
  try {
    ctx.ui?.setStatus?.("jev-router", text);
  } catch {
    // Ignore UI failures.
  }
}

interface DecisionEntryOverrides {
  tier?: string;
  model?: string;
  kindSpecialised?: boolean;
  trace?: Decision["trace"];
}

function cloneDecisionTrace(trace: Decision["trace"]): Decision["trace"] {
  return {
    ...trace,
    composition: { ...trace.composition },
    steps: trace.steps.map((step) => ({ ...step })),
  };
}

function appendDecisionEntry(
  analysis: RouteAnalysis,
  decision: Decision,
  action: DecisionEntry["action"],
  runtime: Runtime,
  overrides: DecisionEntryOverrides = {},
): void {
  const model = overrides.model ?? (decision.model
    ? `${decision.model.provider}/${decision.model.id}`
    : `${decision.target.provider}/${decision.target.model}`);
  appendEntry(
    {
      action,
      tier: overrides.tier ?? decision.tier,
      desiredTier: decision.desiredTier,
      model,
      kind: analysis.kind,
      kindConfidence: analysis.kindConfidence,
      complexity: analysis.complexity,
      capability: analysis.budgetIntensity,
      deepReasoning: analysis.deepReasoning,
      demand: decision.demandScore,
      pressure: decision.budgetPressure,
      kindSpecialised: overrides.kindSpecialised ?? decision.kindSpecialised,
      reason: decision.reason,
      notes: [...decision.notes],
      trace: cloneDecisionTrace(overrides.trace ?? decision.trace),
      at: Date.now(),
    },
    runtime,
  );
}

const SKIP_REASONS: Record<string, string> = {
  acknowledgement: "acknowledgement — staying on the current model",
  "short continuation": "short continuation — staying on the current model",
  "no route available": "no configured route is available — staying on the current model",
};

/** Log prompts that were intentionally not routed, so the behaviour is never invisible. */
function appendSkipEntry(skipReason: string, ctx: ExtensionContext, runtime: Runtime): void {
  if (skipReason === "empty" || skipReason === "slash command") return;
  const model = currentModelKey(ctx) ?? "unknown";
  appendEntry(
    {
      action: "skipped",
      tier: runtime.appliedTierIndex !== undefined ? TIERS[runtime.appliedTierIndex] : "current",
      model,
      kind: skipReason,
      kindConfidence: 0,
      complexity: 0,
      capability: 0,
      deepReasoning: 0,
      demand: 0,
      pressure: spendSnapshot(runtime.ledger, runtime.config.budget).pressure,
      reason:
        SKIP_REASONS[skipReason] ??
        `${skipReason} — staying on the current model`,
      notes: [],
      skipReason,
      at: Date.now(),
    },
    runtime,
  );
}

function toAvailable(ctx: ExtensionContext): AvailableModel[] {
  try {
    const list = ctx.modelRegistry?.getAvailable?.();
    if (!Array.isArray(list)) return [];
    const scoped = ctx.scopedModels;
    const scopedKeys = Array.isArray(scoped) && scoped.length > 0
      ? new Set(scoped.map(({ model }) => `${model.provider}/${model.id}`))
      : undefined;
    return list
      .filter((model) => !scopedKeys || scopedKeys.has(`${model.provider}/${model.id}`))
      .map((model) => ({
        provider: model.provider,
        id: model.id,
        name: model.name,
        reasoning: model.reasoning,
        cost: model.cost
          ? {
              input: model.cost.input,
              output: model.cost.output,
              cacheRead: model.cost.cacheRead,
              cacheWrite: model.cost.cacheWrite,
            }
          : undefined,
      }));
  } catch {
    return [];
  }
}

function currentModelKey(ctx: ExtensionContext): string | undefined {
  return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

function sessionIdFor(ctx: ExtensionContext): string | undefined {
  try {
    const manager = ctx.sessionManager as { getSessionId?: () => string };
    return typeof manager.getSessionId === "function"
      ? manager.getSessionId.call(ctx.sessionManager)
      : undefined;
  } catch {
    return undefined;
  }
}

function historyExcerpt(ctx: ExtensionContext, turns: number): string | undefined {
  if (turns <= 0) return undefined;
  const lines: string[] = [];
  try {
    const entries = ctx.sessionManager.buildContextEntries();
    for (const entry of entries) {
      const record = entry as { type?: string; message?: { role?: string; content?: unknown } };
      if (record.type !== "message" || !record.message) continue;
      const { role, content } = record.message;
      if (role !== "user" && role !== "assistant") continue;
      const text = contentToText(content);
      if (!text) continue;
      lines.push(`${role}: ${text.length > 600 ? `${text.slice(0, 600)}…` : text}`);
    }
  } catch {
    return undefined;
  }
  // Keep the last `turns` user-facing exchanges, newest last.
  const tail = lines.slice(-(turns * 2));
  return tail.length > 0 ? tail.join("\n") : undefined;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      const record = part as { type?: string; text?: string };
      return record.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join(" ")
    .trim();
}

function shouldSkip(text: string, config: JevRouterConfig, hasHistory: boolean): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return "empty";
  if (trimmed.startsWith("/")) return "slash command";
  if (ACK_PATTERN.test(trimmed)) return "acknowledgement";
  // Short messages in an ongoing conversation are usually continuations
  // ("do that", "what about X") and should not re-route. A short first
  // message in a fresh session is a real request and does get routed.
  if (trimmed.length < config.minPromptChars && hasHistory) return "short continuation";
  return undefined;
}

async function apiKeyForContext(config: JevRouterConfig, ctx: ExtensionContext): Promise<string> {
  const configured = apiKeyFor(config);
  if (configured) return configured;
  if (config.jevProvider !== "openrouter") return "";
  try {
    return (await ctx.modelRegistry?.getApiKeyForProvider?.("openrouter"))?.trim() ?? "";
  } catch {
    return "";
  }
}

function missingApiKeyMessage(config: JevRouterConfig): string {
  const loginHint = config.jevProvider === "openrouter" ? " or run /login openrouter" : "";
  return `missing ${config.jevProvider} API key (set ${config.apiKeyEnv}, add \"apiKey\" to the router config${loginHint})`;
}

function statusLine(ctx: ExtensionContext, runtime: Runtime): void {
  const spend = spendSnapshot(runtime.ledger, runtime.config.budget);
  if (!runtime.config.enabled) {
    setStatus(ctx, "jev-router:off");
    return;
  }
  const tier = runtime.appliedTierIndex !== undefined ? TIERS[runtime.appliedTierIndex] : "on";
  const parts = [`jev-router:${tier}`];
  if (spend.today > 0) parts.push(formatUsd(spend.today));
  if (spend.pressure > 0) parts.push(`${Math.round(spend.pressure * 100)}%`);
  if (runtime.config.mode !== "auto") parts.push(runtime.config.mode);
  setStatus(ctx, parts.join(" · "));
}

function acceptLedgerUpdate(
  result: LedgerUpdateResult,
  ctx: ExtensionContext,
  runtime: Runtime,
): void {
  runtime.ledger = result.ledger;
  if (!result.persisted) {
    if (!runtime.ledgerPersistenceFailed) {
      const detail = result.error ? `: ${result.error}` : "";
      notify(
        ctx,
        `jev-router: ledger persistence failed; ${result.pendingUpdates} update(s) queued for retry${detail}`,
        "warning",
      );
    }
    runtime.ledgerPersistenceFailed = true;
    return;
  }
  if (runtime.ledgerPersistenceFailed) {
    notify(ctx, "jev-router: queued ledger updates persisted", "info");
  }
  runtime.ledgerPersistenceFailed = false;
}

async function analyse(
  prompt: string,
  ctx: ExtensionContext,
  runtime: Runtime,
): Promise<{ analysis: RouteAnalysis; decision?: Decision } | { error: string }> {
  const config = runtime.config;
  const apiKey = await apiKeyForContext(config, ctx);
  if (!apiKey) {
    return { error: missingApiKeyMessage(config) };
  }
  if (runtime.models.length === 0) runtime.models = toAvailable(ctx);
  runtime.ledger = loadLedger(config.stateFile);
  const spend = spendSnapshot(runtime.ledger, config.budget);
  // Context size prices the cache miss a switch would cause.
  const contextTokens = ctx.getContextUsage?.()?.tokens ?? undefined;
  const activeKey = currentModelKey(ctx);

  const analysis = await classifyRequest(
    {
      prompt,
      history: historyExcerpt(ctx, config.historyTurns),
    },
    config,
    apiKey,
    ctx.signal,
  );

  if (analysis.usage) {
    acceptLedgerUpdate(
      await updateLedger(config.stateFile, {
        type: "jev",
        sessionId: runtime.sessionId,
        inputTokens: analysis.usage.input_tokens,
        outputTokens: analysis.usage.output_tokens,
      }),
      ctx,
      runtime,
    );
  }
  const decision = decide(analysis, config, {
    models: runtime.models,
    spend,
    contextTokens,
    current: {
      index: tierForModel(activeKey, config),
      model: runtime.models.find((model) => `${model.provider}/${model.id}` === activeKey),
    },
  });
  return { analysis, decision };
}

interface ApplyResult {
  action: "switched" | "kept" | "notified" | "skipped";
  message: string;
}

function decisionPresentation(decision: Decision): {
  target: string;
  headline: string;
  detail: string;
} {
  const target = decision.model
    ? `${decision.model.provider}/${decision.model.id}`
    : `${decision.target.provider}/${decision.target.model}`;
  return {
    target,
    headline: `Jev → ${decision.tier} (${target})`,
    detail: `${decision.reason}${decision.notes.length ? ` · ${decision.notes.join(" · ")}` : ""}`,
  };
}

async function applyDecision(
  analysis: RouteAnalysis,
  decision: Decision,
  ctx: ExtensionContext,
  runtime: Runtime,
  options: { allowPrompt?: boolean } = {},
): Promise<ApplyResult> {
  let { target, headline, detail } = decisionPresentation(decision);
  const currentKey = currentModelKey(ctx);
  const targetKey = decision.model ? `${decision.model.provider}/${decision.model.id}` : undefined;
  const keepCurrent =
    decision.held === true ||
    (runtime.config.stickiness && targetKey !== undefined && currentKey === targetKey);

  if (keepCurrent) {
    if (decision.target.thinkingLevel) {
      setThinking(decision.target.thinkingLevel);
    }
    runtime.appliedTierIndex = decision.tierIndex;
    runtime.lastDecision = decision;
    runtime.lastAnalysis = analysis;
    setStatus(ctx, `jev-router:${decision.tier} ✓`);
    appendDecisionEntry(analysis, decision, "kept", runtime);
    return { action: "kept", message: `${headline} — already active` };
  }

  if (runtime.config.mode === "notify") {
    notify(ctx, `${headline}\n${detail}`, "info");
    appendDecisionEntry(analysis, decision, "notified", runtime);
    return { action: "notified", message: `${headline} (notify only)` };
  }

  // Confirm mode needs a working select prompt; otherwise fall through to auto-switch.
  if (
    runtime.config.mode === "confirm" &&
    options.allowPrompt !== false &&
    typeof ctx.ui?.select === "function"
  ) {
    const recommendedOption = `Use ${decision.tier} — ${target}`;
    const cheaper = decision.tierIndex > 0 ? TIERS[decision.tierIndex - 1] : undefined;
    const cheaperAvailable = cheaper
      ? firstAvailable(runtime.models, runtime.config.routes[cheaper])
      : undefined;
    const cheaperKey = cheaperAvailable
      ? `${cheaperAvailable.model.provider}/${cheaperAvailable.model.id}`
      : undefined;
    const cheaperOption = cheaper && cheaperAvailable && cheaperKey !== currentKey
      ? `Use ${cheaper} — ${cheaperKey}`
      : undefined;
    const keepOption = `Keep ${currentModelKey(ctx) ?? "current model"}`;
    const choices = [recommendedOption, ...(cheaperOption ? [cheaperOption] : []), keepOption];
    const choice = await ctx.ui.select(`Jev suggests ${decision.tier}\n${detail}`, choices);
    if (!choice || choice === keepOption) {
      const keptModel = currentModelKey(ctx) ?? "current model";
      const keptIndex = tierForModel(keptModel, runtime.config);
      const keptTier = keptIndex === undefined ? "current" : TIERS[keptIndex];
      const trace = cloneDecisionTrace(decision.trace);
      trace.selectedBy = "user";
      trace.steps.push({
        gate: "user",
        outcome: "held",
        fromTier: decision.tier,
        toTier: keptTier,
        summary: `confirm selection kept ${keptTier}`,
      });
      appendDecisionEntry(analysis, decision, "skipped", runtime, {
        tier: keptTier,
        model: keptModel,
        kindSpecialised: false,
        trace,
      });
      return { action: "skipped", message: "kept current model" };
    }
    if (choice === cheaperOption && cheaper && cheaperAvailable) {
      const recommendedTier = decision.tier;
      decision.model = cheaperAvailable.model;
      decision.target = cheaperAvailable.target;
      decision.tier = cheaper;
      decision.tierIndex = tierIndex(cheaper);
      decision.downgraded = decision.tierIndex < tierIndex(decision.desiredTier);
      decision.kindSpecialised = false;
      const confirmation = `confirm selection → ${cheaper}`;
      decision.notes.push(confirmation);
      decision.trace.selectedBy = "user";
      decision.trace.steps.push({
        gate: "user",
        outcome: "changed",
        fromTier: recommendedTier,
        toTier: cheaper,
        summary: confirmation,
      });
    } else if (choice !== recommendedOption) {
      appendDecisionEntry(analysis, decision, "skipped", runtime);
      return { action: "skipped", message: "kept current model" };
    }

    ({ target, headline, detail } = decisionPresentation(decision));
  }

  const model =
    decision.model && typeof ctx.modelRegistry?.find === "function"
      ? ctx.modelRegistry.find(decision.model.provider, decision.model.id)
      : undefined;
  if (!model) {
    appendDecisionEntry(analysis, decision, "skipped", runtime);
    return { action: "skipped", message: `${headline} — model not available in this build` };
  }

  const previous = currentModelKey(ctx);
  const ok = await switchModel(model);
  if (!ok) {
    appendDecisionEntry(analysis, decision, "skipped", runtime);
    return { action: "skipped", message: `${headline} — no auth configured for provider` };
  }

  if (previous && previous !== `${model.provider}/${model.id}`) runtime.previousModelKey = previous;
  if (decision.target.thinkingLevel) {
    setThinking(decision.target.thinkingLevel);
  }

  runtime.appliedTierIndex = decision.tierIndex;
  runtime.lastDecision = decision;
  runtime.lastAnalysis = analysis;
  statusLine(ctx, runtime);
  notify(ctx, `${headline}\n${detail}`, "info");
  appendDecisionEntry(analysis, decision, "switched", runtime);
  return { action: "switched", message: `${headline}` };
}

// The ExtensionAPI instance for the running session, captured at load time.
// Only used for session-level model/thinking changes.
let api: ExtensionAPI | undefined;

async function switchModel(model: unknown): Promise<boolean> {
  if (!api || typeof api.setModel !== "function") return false;
  try {
    return await api.setModel(model as never);
  } catch {
    return false;
  }
}

function setThinking(level: string): void {
  if (!api || typeof api.setThinkingLevel !== "function") return;
  try {
    api.setThinkingLevel(level as never);
  } catch {
    // Clamping is model-specific; ignore unsupported levels.
  }
}

interface TraceSection {
  title: string;
  lines: string[];
}

function traceMarker(outcome: Decision["trace"]["steps"][number]["outcome"]): string {
  return outcome === "passed" ? "✓" : outcome === "held" ? "=" : "↳";
}

function decisionTraceSections(data: {
  trace: Decision["trace"];
  tier: string;
  model: string;
  kindSpecialised?: boolean;
  action?: DecisionEntry["action"];
}): TraceSection[] {
  const composition = data.trace.composition;
  const reasoning = composition.reasoningAdjustment >= 0
    ? `+${composition.reasoningAdjustment.toFixed(2)}`
    : composition.reasoningAdjustment.toFixed(2);
  return [
    {
      title: "Composition",
      lines: [
        `weighted demand: ${composition.weightedDemand.toFixed(2)}`,
        `reasoning adjustment: ${reasoning}`,
        `kind floor: ${composition.kindFloor}`,
        `demand: ${composition.demand.toFixed(2)} → desired ${composition.desiredTier}`,
      ],
    },
    {
      title: "Policy gates",
      lines: data.trace.steps.map((step) =>
        `${traceMarker(step.outcome)} ${step.gate}: ${step.summary}`),
    },
    {
      title: "Final",
      lines: [
        `actual tier: ${data.tier}`,
        `model: ${data.model}`,
        `selected by: ${data.trace.selectedBy}`,
        `route: ${data.kindSpecialised ? "kind specialist" : "tier chain"}`,
        ...(data.action ? [`action: ${data.action}`] : []),
      ],
    },
  ];
}

function formatDecisionTrace(decision: Decision): string {
  const { target } = decisionPresentation(decision);
  return decisionTraceSections({
    trace: decision.trace,
    tier: decision.tier,
    model: target,
    kindSpecialised: decision.kindSpecialised,
  })
    .flatMap((section) => [section.title, ...section.lines.map((line) => `  ${line}`)])
    .join("\n");
}

function formatAnalysis(analysis: RouteAnalysis): string {
  const probs = Object.entries(analysis.kindProbabilities)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, p]) => `${kind} ${(p * 100).toFixed(0)}%`)
    .join(", ");
  return [
    `kind: ${analysis.kind} (confidence ${analysis.kindConfidence.toFixed(2)})`,
    `      ${probs}`,
    `complexity: ${analysis.complexity.toFixed(2)}/3 (conf ${analysis.complexityConfidence.toFixed(2)})`,
    `capability deserved: ${analysis.budgetIntensity.toFixed(2)}/3 (conf ${analysis.budgetIntensityConfidence.toFixed(2)})`,
    `deep reasoning: ${(analysis.deepReasoning * 100).toFixed(0)}%`,
    `jev latency: ${analysis.latencyMs}ms`,
  ].join("\n");
}

export default async function jevRouterExtension(pi: ExtensionAPI): Promise<void> {
  api = pi;

  const runtime: Runtime = {
    config: loadConfig(),
    ledger: loadLedger(loadConfig().stateFile),
    models: [],
  };

  // Not every pi build/fork exposes the full ExtensionAPI surface. Detect the
  // optional capabilities once so their absence degrades instead of failing install.
  const hasCommands = typeof pi.registerCommand === "function";
  const hasTools = typeof pi.registerTool === "function";

  // Optional: durable, TUI-only record of each routing decision (never sent to the LLM).
  // `registerEntryRenderer` and the pi-tui components are not available in every pi
  // build or fork, so feature-detect them and never let rendering break extension load.
  if (typeof pi.registerEntryRenderer === "function") {
    try {
      const { Box, Text } = await import("@earendil-works/pi-tui");
      pi.registerEntryRenderer<DecisionEntry>("jev-router-decision", (entry, { expanded }, theme) => {
        const data = entry.data;
        const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
        if (!data) {
          box.addChild(new Text(theme.fg("dim", "jev-router: no decision data"), 0, 0));
          return box;
        }
        const glyph =
          data.action === "switched" ? "→" : data.action === "kept" ? "=" : data.action === "notified" ? "•" : "×";
        const label = data.skipReason ? `${theme.fg("accent", "jev-router ·")} ${theme.bold("not routed")}` : `${theme.fg("accent", `jev-router ${glyph} ${data.tier}`)}  ${theme.bold(data.model)}`;
        box.addChild(new Text(label, 0, 0));
        if (data.skipReason) {
          box.addChild(new Text(theme.fg("dim", `${data.reason}`), 0, 0));
          box.addChild(new Text(theme.fg("dim", `using ${data.model}`), 0, 0));
          return box;
        }
        if (data.trace) {
          const desiredTier = data.desiredTier ?? data.trace.composition.desiredTier;
          box.addChild(
            new Text(
              theme.fg(
                "dim",
                `${data.kind} · demand ${data.demand.toFixed(2)} · desired ${desiredTier} → actual ${data.tier}`,
              ),
              0,
              0,
            ),
          );
          const changed = data.trace.steps.filter((step) => step.outcome !== "passed");
          if (!expanded && changed.length > 0) {
            box.addChild(
              new Text(
                theme.fg(
                  "dim",
                  changed
                    .map((step) => `· ${step.gate}: ${step.fromTier} → ${step.toTier}`)
                    .join("\n"),
                ),
                0,
                0,
              ),
            );
          }
          if (expanded) {
            box.addChild(new Text(theme.bold("Jev judgment"), 0, 0));
            box.addChild(
              new Text(
                theme.fg(
                  "dim",
                  `  kind: ${data.kind} (${(data.kindConfidence * 100).toFixed(0)}% confidence)\n` +
                    `  complexity: ${data.complexity.toFixed(2)}/3\n` +
                    `  capability: ${data.capability.toFixed(2)}/3\n` +
                    `  deep reasoning: ${(data.deepReasoning * 100).toFixed(0)}%`,
                ),
                0,
                0,
              ),
            );
            for (const section of decisionTraceSections({
              trace: data.trace,
              tier: data.tier,
              model: data.model,
              kindSpecialised: data.kindSpecialised,
              action: data.action,
            })) {
              box.addChild(new Text(theme.bold(section.title), 0, 0));
              box.addChild(
                new Text(
                  theme.fg("dim", section.lines.map((line) => `  ${line}`).join("\n")),
                  0,
                  0,
                ),
              );
            }
          }
        } else {
          box.addChild(new Text(theme.fg("dim", data.reason), 0, 0));
          if (data.notes.length > 0) {
            box.addChild(new Text(theme.fg("dim", data.notes.map((note) => `· ${note}`).join("\n")), 0, 0));
          }
          if (expanded) {
            box.addChild(
              new Text(
                theme.fg(
                  "dim",
                  `kind ${data.kind} (conf ${data.kindConfidence.toFixed(2)}) · ` +
                    `complexity ${data.complexity.toFixed(2)}/3 · capability ${data.capability.toFixed(2)}/3 · ` +
                    `deep reasoning ${(data.deepReasoning * 100).toFixed(0)}% · demand ${data.demand.toFixed(2)}` +
                    (data.pressure > 0 ? ` · budget ${(data.pressure * 100).toFixed(0)}% of cap` : ""),
                ),
                0,
                0,
              ),
            );
          }
        }
        return box;
      });
    } catch {
      // TUI rendering unavailable in this build: decisions are still reported
      // through the status bar and notify, and persist as session entries.
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    const projectTrusted =
      typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted();
    runtime.config = loadConfig(ctx.cwd, projectTrusted);
    runtime.ledger = loadLedger(runtime.config.stateFile);
    runtime.models = toAvailable(ctx);
    runtime.sessionId = sessionIdFor(ctx);
    runtime.ledgerPersistenceFailed = false;
    runtime.appliedTierIndex = tierForModel(currentModelKey(ctx), runtime.config);
    statusLine(ctx, runtime);
    if (runtime.config.enabled && !(await apiKeyForContext(runtime.config, ctx))) {
      notify(ctx, `pi-jev-model-router: ${missingApiKeyMessage(runtime.config)}.`, "warning");
    }
    if (runtime.config.enabled && !runtime.config.useDefaultModels) {
      const emptyTiers = TIERS.filter((tier) => runtime.config.routes[tier].length === 0);
      if (emptyTiers.length > 0) {
        notify(
          ctx,
          `pi-jev-model-router: useDefaultModels is off and no models are configured for: ${emptyTiers.join(", ")}. Routing will skip those tiers.`,
          "warning",
        );
      }
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    acceptLedgerUpdate(await flushLedger(runtime.config.stateFile), ctx, runtime);
  });

  pi.on("model_select", async (_event, ctx) => {
    runtime.models = toAvailable(ctx);
    runtime.appliedTierIndex = tierForModel(currentModelKey(ctx), runtime.config);
    statusLine(ctx, runtime);
  });

  // Spend accounting: every assistant message carries its computed cost.
  pi.on("message_end", async (event, ctx) => {
    const message = event.message as {
      role?: string;
      provider?: string;
      model?: string;
      usage?: { cost?: { total?: number } };
    };
    if (message.role !== "assistant") return;
    const cost = message.usage?.cost?.total;
    const key = message.provider && message.model ? `${message.provider}/${message.model}` : "unknown";
    if (typeof cost === "number" && cost > 0) {
      acceptLedgerUpdate(
        await updateLedger(runtime.config.stateFile, {
          type: "cost",
          sessionId: runtime.sessionId,
          modelKey: key,
          usd: cost,
        }),
        ctx,
        runtime,
      );
    }
  });

  // The routing hook: classify the prompt with Jev, then switch models in place.
  pi.on("input", async (event, ctx) => {
    if (!runtime.config.enabled) return { action: "continue" };
    if (event.source === "extension") return { action: "continue" };
    if (event.images?.length && !event.text?.trim()) return { action: "continue" };

    const text = event.text ?? "";
    const hasHistory = (historyExcerpt(ctx, 1)?.length ?? 0) > 0;
    const skip = shouldSkip(text, runtime.config, hasHistory);
    if (skip) {
      appendSkipEntry(skip, ctx, runtime);
      return { action: "continue" };
    }

    runtime.lastPrompt = text.trim();
    setStatus(ctx, "jev-router:…");
    try {
      const result = await analyse(text, ctx, runtime);
      if ("error" in result) {
        statusLine(ctx, runtime);
        notify(ctx, `jev-router: ${result.error}`, "warning");
        return { action: "continue" };
      }
      const { analysis, decision } = result;
      runtime.lastAnalysis = analysis;
      if (!decision) {
        appendSkipEntry("no route available", ctx, runtime);
        statusLine(ctx, runtime);
        return { action: "continue" };
      }
      await applyDecision(analysis, decision, ctx, runtime);
    } catch (error) {
      statusLine(ctx, runtime);
      const message = error instanceof JevError ? error.message : error instanceof Error ? error.message : String(error);
      if (!/abort/i.test(message)) notify(ctx, `jev-router: ${message}`, "warning");
    }
    return { action: "continue" };
  });

  if (hasCommands) pi.registerCommand("jev-router", {
    description: "Jev model router: status, on/off, mode, budget",
    handler: async (args, ctx) => {
      const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      switch ((sub ?? "status").toLowerCase()) {
        case "on":
          runtime.config.enabled = true;
          statusLine(ctx, runtime);
          notify(ctx, "jev-router enabled", "info");
          return;
        case "off":
          runtime.config.enabled = false;
          statusLine(ctx, runtime);
          notify(ctx, "jev-router disabled", "info");
          return;
        case "mode": {
          const mode = (rest[0] ?? "").toLowerCase();
          if (mode !== "auto" && mode !== "confirm" && mode !== "notify") {
            notify(ctx, "usage: /jev-router mode auto|confirm|notify", "warning");
            return;
          }
          runtime.config.mode = mode;
          statusLine(ctx, runtime);
          notify(ctx, `jev-router mode: ${mode}`, "info");
          return;
        }
        case "budget": {
          const [, amountRaw] = rest;
          const amount = Number.parseFloat(amountRaw ?? "");
          if (!Number.isFinite(amount) || amount <= 0) {
            notify(ctx, "usage: /jev-router budget daily|monthly <usd>", "warning");
            return;
          }
          if (rest[0] === "daily") runtime.config.budget.dailyUsd = amount;
          else if (rest[0] === "monthly") runtime.config.budget.monthlyUsd = amount;
          else {
            notify(ctx, "usage: /jev-router budget daily|monthly <usd>", "warning");
            return;
          }
          statusLine(ctx, runtime);
          notify(ctx, `budget ${rest[0]} cap: ${formatUsd(amount)} (session only — persist in pi-jev-model-router.json)`, "info");
          return;
        }
        case "revert": {
          if (!runtime.previousModelKey) {
            notify(ctx, "no previous model recorded", "warning");
            return;
          }
          const [provider, ...idParts] = runtime.previousModelKey.split("/");
          const model =
            typeof ctx.modelRegistry?.find === "function"
              ? ctx.modelRegistry.find(provider, idParts.join("/"))
              : undefined;
          if (!model) {
            notify(ctx, `previous model not found: ${runtime.previousModelKey}`, "warning");
            return;
          }
          await switchModel(model);
          notify(ctx, `reverted to ${runtime.previousModelKey}`, "info");
          return;
        }
        case "why": {
          if (!runtime.lastPrompt) {
            notify(ctx, "no routed prompt yet in this session", "warning");
            return;
          }
          const result = await analyse(runtime.lastPrompt, ctx, runtime);
          if ("error" in result) {
            notify(ctx, result.error, "warning");
            return;
          }
          const { analysis, decision } = result;
          notify(ctx, 
            [
              formatAnalysis(analysis),
              "",
              decision ? formatDecisionTrace(decision) : "no route available",
            ]
              .filter(Boolean)
              .join("\n"),
            "info",
          );
          return;
        }
        case "status":
        default: {
          const spend = spendSnapshot(runtime.ledger, runtime.config.budget);
          const lines = [
            `enabled: ${runtime.config.enabled}`,
            `mode: ${runtime.config.mode}`,
            `jev provider: ${runtime.config.jevProvider}`,
            `jev model: ${runtime.config.jevModel}`,
            `api key: ${(await apiKeyForContext(runtime.config, ctx)) ? "configured ✓" : "missing"}`,
            `current model: ${currentModelKey(ctx) ?? "unknown"}`,
            `spend today: ${formatUsd(spend.today)}${spend.dailyCap ? ` / ${formatUsd(spend.dailyCap)}` : ""}`,
            `spend month: ${formatUsd(spend.month)}${spend.monthlyCap ? ` / ${formatUsd(spend.monthlyCap)}` : ""}`,
            `budget pressure: ${spend.pressure > 0 ? `${(spend.pressure * 100).toFixed(0)}%` : "no caps set"}`,
            `cache-aware: ${runtime.config.cache.aware ? `on (cap ${formatUsd(runtime.config.cache.maxPenaltyUsd)}, deadband ${runtime.config.cache.deadband})` : "off"}`,
            `built-in models: ${runtime.config.useDefaultModels ? "on" : "off (config-only)"}`,
            `jev requests: ${runtime.ledger.jev.requests}`,
            "",
            "routes:",
            ...TIERS.map((tier) => {
              const route = runtime.config.routes[tier];
              if (route.length === 0) return `  ✗ ${tier.padEnd(9)} (none configured)`;
              const pick = firstAvailable(runtime.models, route);
              const marker = pick ? "✓" : "✗";
              const label = pick ? `${pick.model.provider}/${pick.model.id}` : `${route[0]?.provider}/${route[0]?.model}`;
              const alts = route.length > 1 ? ` (+${route.length - 1} fallback${route.length > 2 ? "s" : ""})` : "";
              return `  ${marker} ${tier.padEnd(9)} ${label}${alts}`;
            }),
            "",
            `kind specialists (${Object.keys(runtime.config.kindModels).length}):`,
            ...Object.entries(runtime.config.kindModels).map(([kind, chain]) => {
              const pick = firstAvailable(runtime.models, chain);
              const floor = runtime.config.kindMinimumTier[kind] ?? "quick";
              return `  ${pick ? "✓" : "✗"} ${kind.padEnd(10)} ≥${floor.padEnd(9)} ${pick ? pick.model.id : (chain[0]?.model ?? "(none configured)")}`;
            }),
            "",
            runtime.lastDecision ? `last: ${describeDecision(runtime.lastDecision)}` : "last: none",
            "",
            "commands: /jev-router on|off|mode|budget|why|revert · /jev-route <text>",
          ];
          notify(ctx, lines.join("\n"), "info");
          return;
        }
      }
    },
  });

  if (hasCommands) pi.registerCommand("jev-route", {
    description: "Ask Jev which model tier a request deserves (no switching)",
    handler: async (args, ctx) => {
      const text = args.trim() || runtime.lastPrompt || "";
      if (!text) {
        notify(ctx, "usage: /jev-route <text>", "warning");
        return;
      }
      const result = await analyse(text, ctx, runtime);
      if ("error" in result) {
        notify(ctx, result.error, "warning");
        return;
      }
      const { analysis, decision } = result;
      notify(ctx,
        [formatAnalysis(analysis), "", decision ? formatDecisionTrace(decision) : "no route available"].join("\n"),
        "info",
      );
    },
  });

  if (hasTools) pi.registerTool({
    name: "jev_route",
    label: "Jev Route",
    description:
      "Ask Jev what kind of work a request is and which model tier it deserves. Returns typed judgments (task kind, complexity, capability deserved, deep-reasoning need) plus a recommended model from the configured tiers. Use when deciding how much model to spend on a subtask.",
    promptSnippet: "Classify a request with Jev and get a recommended model tier",
    parameters: Type.Object({
      request: Type.String({ description: "The request or task text to classify" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await analyse(params.request, ctx, runtime);
      if ("error" in result) {
        throw new Error(`jev_route: ${result.error}`);
      }
      const { analysis, decision } = result;
      const text = [
        formatAnalysis(analysis),
        "",
        decision ? formatDecisionTrace(decision) : "no route available",
      ]
        .filter(Boolean)
        .join("\n");
      return {
        content: [{ type: "text", text }],
        details: { analysis, decision },
      };
    },
  });
}