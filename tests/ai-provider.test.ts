import { test } from "node:test";
import assert from "node:assert/strict";
import { createAiConfig } from "../apps/api/src/ai-provider.ts";
import { excerptPlanSources } from "../packages/domain/plan.ts";

const input = {
  type: "Business requirements document",
  implementation: { name: "Local test" },
  context: { meeting_transcript_segments: [] },
  userNotes: "Keep unanswered questions visible.",
};
const draft = { content: "# Business Requirements Document\n\n## Scope\n\n[CONFIRM: project scope and sign-off]", source_notes: [], open_questions: ["Confirm scope"], proposals: [] };

test("Gemini generation uses the official endpoint and structured output without exposing the key in the URL", async () => {
  const config = createAiConfig({ AI_PROVIDER: "Gemini", GEMINI_API_KEY: "local-test-secret" }, async (url, init) => {
    assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
    assert.equal((init?.headers as Record<string, string>)["x-goog-api-key"], "local-test-secret");
    assert.equal((init?.headers as Record<string, string>).Authorization, undefined);
    const body = JSON.parse(String(init?.body));
    assert.match(body.systemInstruction.parts[0].text, /Do not invent/);
    assert.equal(body.contents[0].role, "user");
    assert.equal(body.generationConfig.responseFormat.text.mimeType, "APPLICATION_JSON");
    assert.deepEqual(body.generationConfig.responseFormat.text.schema.required, ["content", "source_notes", "open_questions", "proposals"]);
    return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(draft) }] } }] });
  });
  assert.equal(config.aiProvider, "Gemini");
  assert.equal(config.aiModel, "gemini-3.8-flash");
  assert.deepEqual(await config.generateDocument!(input), draft);
  assert.equal(createAiConfig({ AI_PROVIDER: "Gemini" }).generateDocument, undefined);
  assert.throws(() => createAiConfig({ AI_PROVIDER: "Gemini", GEMINI_API_KEY: "x", AI_MODEL: "../../bad" }), /Gemini model ID/);
});

test("OpenAI generation uses server-side Responses structured output without storing the response", async () => {
  let called = false;
  const config = createAiConfig({ OPENAI_API_KEY: "local-test-secret", AI_MODEL: "gpt-5.4-mini" }, async (url, init) => {
    called = true;
    assert.equal(url, "https://api.openai.com/v1/responses");
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer local-test-secret");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.store, false);
    assert.equal(body.text.format.type, "json_schema");
    assert.equal(body.text.format.strict, true);
    assert.equal(body.model, "gpt-5.4-mini");
    assert.equal(body.input[1].role, "user");
    return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(draft) }] }] });
  });
  assert.deepEqual(await config.generateDocument!(input), draft);
  assert.equal(called, true);
});

test("custom OpenAI-compatible provider keeps chat completions contract", async () => {
  const config = createAiConfig({ AI_PROVIDER: "Local test", AI_BASE_URL: "http://127.0.0.1:12000/v1", AI_API_KEY: "local-only", AI_MODEL: "mock" }, async (url, init) => {
    assert.equal(url, "http://127.0.0.1:12000/v1/chat/completions");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.response_format.type, "json_object");
    return Response.json({ choices: [{ message: { content: JSON.stringify(draft) } }] });
  });
  assert.deepEqual(await config.generateDocument!(input), draft);
  assert.equal(createAiConfig({}).generateDocument, undefined);
  assert.equal(createAiConfig({ OPENAI_API_KEY: "secret", AI_BASE_URL: "https://different-provider.example/v1", AI_MODEL: "mock" }).generateDocument, undefined);
  assert.throws(() => createAiConfig({ AI_BASE_URL: "http://example.com/v1", AI_API_KEY: "x", AI_MODEL: "mock" }), /HTTPS/);
});

test("NVIDIA hosted provider requests a strict draft schema without reasoning tokens", async () => {
  const config = createAiConfig({ AI_PROVIDER: "NVIDIA", AI_BASE_URL: "https://integrate.api.nvidia.com/v1", AI_API_KEY: "local-test-secret", AI_MODEL: "nvidia/nemotron-3.5-lightning-30b-a3b" }, async (url, init) => {
    assert.equal(url, "https://integrate.api.nvidia.com/v1/chat/completions");
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer local-test-secret");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.response_format.type, "json_schema");
    assert.equal(body.response_format.json_schema.strict, true);
    assert.equal(body.max_tokens, 8192);
    assert.equal(body.chat_template_kwargs.enable_thinking, false);
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(draft) } }] });
  });
  assert.deepEqual(await config.generateDocument!(input), draft);
});

test("plan source excerpts stay bounded and preserve quotable source text", () => {
  const content = `${"Background context. ".repeat(700)}\nThe client requires UAT sign-off before go-live.\n${"Additional notes. ".repeat(700)}`;
  const sources = Array.from({ length: 6 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    kind: "DOCUMENT" as const, title: "Test", content, status: "ACTIVE", version: 1,
  }));
  const excerpts = excerptPlanSources(sources);
  assert.ok(excerpts.every((source) => source.content.length <= 3000));
  assert.ok(excerpts.every((source) => source.content.includes("UAT sign-off")));
  assert.equal(sources[0].content, content);
});

test("NVIDIA plan generation normalizes technical keys and dependency references", async () => {
  const sourceId = "11111111-1111-4111-8111-111111111111";
  const evidence = [{ source_id: sourceId, quote: "Run UAT and approve launch." }];
  const config = createAiConfig({ AI_PROVIDER: "NVIDIA", AI_BASE_URL: "https://integrate.api.nvidia.com/v1", AI_API_KEY: "local-test-secret", AI_MODEL: "nvidia/nemotron-3.5-lightning-30b-a3b" }, async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "nvidia/nemotron-3.5-lightning-30b-a3b");
    assert.equal(body.response_format.type, "json_schema");
    return Response.json({ choices: [{ message: { content: JSON.stringify({
      summary: "Review before launch.", open_questions: [], stages: [{
        key: "UAT Stage", name: "UAT", description: "", entry_criteria: "", exit_criteria: "",
        duration_days: null, approval_required: true, evidence,
        milestones: [], tasks: [
          { key: "Run UAT", title: "Run UAT", description: "", priority: "HIGH", depends_on: [], evidence },
          { key: "Approve Launch", title: "Approve launch", description: "", priority: "HIGH", depends_on: ["Run UAT"], evidence },
        ],
      }],
    }) } }] });
  });
  const result = await config.generatePlan!({ implementation: { name: "Test" }, sources: [{
    id: sourceId, kind: "DOCUMENT", title: "Notes", content: "Run UAT and approve launch.", status: "ACTIVE", version: 1,
  }] });
  assert.equal(result.stages[0].key, "uat-stage");
  assert.deepEqual(result.stages[0].tasks[1].depends_on, ["run-uat"]);
});
