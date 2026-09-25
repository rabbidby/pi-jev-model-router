import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { DEFAULT_CONFIG } from "../extensions/pi-jev-model-router/config";
import { classifyRequest, JevError } from "../extensions/pi-jev-model-router/jev";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("classifyRequest sends only opted-in task context and parses judgments", async () => {
  let requestBody: Record<string, any> | undefined;
  let requestHeaders: Headers | undefined;
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    requestHeaders = new Headers(init?.headers);
    return new Response(
      JSON.stringify({
        answers: {
          task_kind: { choice: "debug", confidence: 0.8, probabilities: { debug: 0.8, implement: 0.2 } },
          complexity: { score: 2.25, confidence: 0.9 },
          capability_deserved: { score: 2.5, confidence: 0.85 },
          needs_deep_reasoning: { noul: 0.7 },
        },
        usage: { input_tokens: 120, output_tokens: 8 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const config = structuredClone(DEFAULT_CONFIG);
  config.jevProvider = "openrouter";
  config.endpoint = "https://example.invalid/decisions";
  config.jevModel = "jev-test";
  const result = await classifyRequest(
    {
      prompt: "Diagnose the failing request",
      history: "user: It returns 500",
    },
    config,
    "secret",
  );

  assert.equal(requestHeaders?.get("authorization"), "Bearer secret");
  assert.equal(requestHeaders?.get("x-title"), "pi-jev-model-router");
  assert.equal(requestBody?.model, "jev-test");
  assert.deepEqual(requestBody?.state, {
    request: "Diagnose the failing request",
    conversation_excerpt: "user: It returns 500",
  });
  assert.equal(Object.keys(requestBody?.questions).length, 4);
  assert.deepEqual(result, {
    kind: "debug",
    kindConfidence: 0.8,
    kindProbabilities: { debug: 0.8, implement: 0.2 },
    complexity: 2.25,
    complexityConfidence: 0.9,
    budgetIntensity: 2.5,
    budgetIntensityConfidence: 0.85,
    deepReasoning: 0.7,
    latencyMs: result.latencyMs,
    usage: { input_tokens: 120, output_tokens: 8 },
  });
});

test("classifyRequest omits all optional context when it is not supplied", async () => {
  let calls = 0;
  let requestBody: Record<string, any> | undefined;
  globalThis.fetch = (async (_input, init) => {
    calls += 1;
    requestBody = JSON.parse(String(init?.body));
    return new Response("invalid key", { status: 401 });
  }) as typeof fetch;

  const config = structuredClone(DEFAULT_CONFIG);
  config.endpoint = "https://example.invalid/decisions";

  await assert.rejects(
    classifyRequest(
      { prompt: "Classify this" },
      config,
      "invalid",
    ),
    (error: unknown) => error instanceof JevError && error.status === 401 && /invalid key/.test(error.message),
  );
  assert.equal(calls, 1);
  assert.deepEqual(requestBody?.state, { request: "Classify this" });
});
