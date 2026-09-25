import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "jev-router-extension-"));
const previousHome = process.env.HOME;
const previousFetch = globalThis.fetch;
const previousEnv = {
  TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  JEV_ROUTER_PROVIDER: process.env.JEV_ROUTER_PROVIDER,
  JEV_ROUTER_MODE: process.env.JEV_ROUTER_MODE,
  JEV_ROUTER_OFF: process.env.JEV_ROUTER_OFF,
};
process.env.HOME = join(root, "home");
for (const key of Object.keys(previousEnv)) delete process.env[key];

const { configPaths } = await import("../extensions/pi-jev-model-router/config");
const { dayKey, loadLedger } = await import("../extensions/pi-jev-model-router/budget");
const { default: extension } = await import("../extensions/pi-jev-model-router/index");
const configFile = configPaths().global;
mkdirSync(dirname(configFile), { recursive: true });

interface ModelFixture {
  provider: string;
  id: string;
}

function writeConfig(routes: Record<string, unknown[]>): void {
  rmSync(join(root, "ledger.json"), { force: true });
  writeFileSync(
    configFile,
    JSON.stringify({
      apiKey: "test",
      mode: "confirm",
      useDefaultModels: false,
      stateFile: join(root, "ledger.json"),
      cache: { aware: false },
      routes,
    }),
  );
}

async function createHarness(
  models: ModelFixture[],
  initialModel?: ModelFixture,
  scopedModels: ModelFixture[] = [],
) {
  const handlers: Record<string, any> = {};
  const tools: Record<string, any> = {};
  const switched: string[] = [];
  const thinking: string[] = [];
  const notifications: string[] = [];
  let shownChoices: string[] = [];
  let currentModel = initialModel;
  let selectStrategy = (choices: string[]) => choices[0];

  const pi = {
    on(name: string, handler: any) {
      handlers[name] = handler;
    },
    registerTool(definition: any) {
      tools[definition.name] = definition;
    },
    async setModel(model: ModelFixture) {
      switched.push(`${model.provider}/${model.id}`);
      currentModel = model;
      return true;
    },
    setThinkingLevel(level: string) {
      thinking.push(level);
    },
  };
  const ctx = {
    cwd: root,
    isProjectTrusted: () => false,
    scopedModels: scopedModels.map((model) => ({ model })),
    get model() {
      return currentModel;
    },
    modelRegistry: {
      getAvailable: () => models,
      find: (provider: string, id: string) =>
        models.find((model) => model.provider === provider && model.id === id),
    },
    sessionManager: {
      buildContextEntries: () => [],
      getSessionId: () => "session-test",
    },
    getContextUsage: () => ({ tokens: 100 }),
    ui: {
      setStatus() {},
      notify(text: string) {
        notifications.push(text);
      },
      async select(_title: string, choices: string[]) {
        shownChoices = choices;
        return selectStrategy(choices);
      },
    },
  };

  await extension(pi as any);
  return {
    handlers,
    tools,
    switched,
    thinking,
    notifications,
    ctx,
    get shownChoices() {
      return shownChoices;
    },
    choose(strategy: (choices: string[]) => string | undefined) {
      selectStrategy = strategy as (choices: string[]) => string;
    },
  };
}

async function route(harness: Awaited<ReturnType<typeof createHarness>>): Promise<void> {
  await harness.handlers.input(
    { source: "interactive", text: "Choose a model for this request" },
    harness.ctx,
  );
}

beforeEach(() => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        answers: {
          task_kind: { choice: "chat", confidence: 1, probabilities: { chat: 1 } },
          complexity: { score: 1, confidence: 1 },
          capability_deserved: { score: 1, confidence: 1 },
          needs_deep_reasoning: { noul: 0.5 },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
});

after(() => {
  globalThis.fetch = previousFetch;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

test("confirm mode omits a cheaper option when no cheaper model is available", async () => {
  const standard = { provider: "test", id: "standard" };
  writeConfig({ standard: [{ provider: "test", model: "standard" }] });
  const harness = await createHarness([standard]);
  await harness.handlers.session_start({}, harness.ctx);

  await route(harness);

  assert.deepEqual(harness.shownChoices, ["Use standard — test/standard", "Keep current model"]);
  assert.deepEqual(harness.switched, ["test/standard"]);
});

test("confirm mode selects the first available cheaper fallback and reports it", async () => {
  const standard = { provider: "test", id: "standard" };
  const quick = { provider: "test", id: "quick-available" };
  writeConfig({
    quick: [
      { provider: "test", model: "quick-unavailable" },
      { provider: "test", model: "quick-available" },
    ],
    standard: [{ provider: "test", model: "standard" }],
  });
  const harness = await createHarness([standard, quick]);
  harness.choose((choices) => choices[1]);
  await harness.handlers.session_start({}, harness.ctx);

  await route(harness);

  assert.equal(harness.shownChoices[1], "Use quick — test/quick-available");
  assert.deepEqual(harness.switched, ["test/quick-available"]);
  assert.match(harness.notifications.at(-1) ?? "", /^Jev → quick \(test\/quick-available\)/);
});

test("routing excludes available models outside the session model scope", async () => {
  const direct = { provider: "openai-codex", id: "standard" };
  const gateway = { provider: "openrouter", id: "quick" };
  writeConfig({
    quick: [{ provider: "openrouter", model: "quick" }],
    standard: [{ provider: "openai-codex", model: "standard" }],
  });
  const harness = await createHarness([direct, gateway], undefined, [gateway]);
  await harness.handlers.session_start({}, harness.ctx);

  await route(harness);

  assert.deepEqual(harness.switched, ["openrouter/quick"]);
  assert.equal(harness.shownChoices[0], "Use quick — openrouter/quick");
});

test("an already-active model still receives its configured thinking level", async () => {
  const standard = { provider: "test", id: "standard" };
  writeConfig({
    standard: [{ provider: "test", model: "standard", thinkingLevel: "medium" }],
  });
  const harness = await createHarness([standard], standard);
  await harness.handlers.session_start({}, harness.ctx);

  await route(harness);

  assert.deepEqual(harness.shownChoices, []);
  assert.deepEqual(harness.switched, []);
  assert.deepEqual(harness.thinking, ["medium"]);
});

test("extension accounting persists deltas under the current session id", async () => {
  const standard = { provider: "test", id: "standard" };
  writeConfig({ standard: [{ provider: "test", model: "standard" }] });
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        answers: {
          task_kind: { choice: "chat", confidence: 1, probabilities: { chat: 1 } },
          complexity: { score: 1, confidence: 1 },
          capability_deserved: { score: 1, confidence: 1 },
          needs_deep_reasoning: { noul: 0.5 },
        },
        usage: { input_tokens: 12, output_tokens: 3 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
  const harness = await createHarness([standard]);
  await harness.handlers.session_start({}, harness.ctx);

  await route(harness);
  await harness.handlers.message_end({
    message: {
      role: "assistant",
      provider: "test",
      model: "standard",
      usage: { cost: { total: 0.5 } },
    },
  });

  const ledger = loadLedger(join(root, "ledger.json"));
  assert.equal(ledger.days[dayKey()]?.bySession["session-test"]?.total, 0.5);
  assert.deepEqual(ledger.jev.bySession["session-test"], {
    requests: 1,
    inputTokens: 12,
    outputTokens: 3,
  });
});

test("jev_route signals missing credentials by throwing", async () => {
  try {
    unlinkSync(configFile);
  } catch {}
  const harness = await createHarness([]);

  await assert.rejects(
    () =>
      harness.tools.jev_route.execute(
        "call-1",
        { request: "Classify this request" },
        undefined,
        undefined,
        harness.ctx,
      ),
    /jev_route: missing typesafe API key/,
  );
});
