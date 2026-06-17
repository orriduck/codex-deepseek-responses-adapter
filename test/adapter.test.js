import test from "node:test";
import assert from "node:assert/strict";
import {
  deepseekRequestBody,
  messagesFromResponsesInput,
  normalizeDeepSeekMessage,
  toolsFromResponsesTools,
} from "../src/adapter.js";

test("converts string input to DeepSeek chat messages", () => {
  assert.deepEqual(messagesFromResponsesInput({ input: "hello" }), [
    { role: "user", content: "hello" },
  ]);
});

test("converts previous function call plus output into assistant/tool messages", () => {
  const store = new Map([
    [
      "resp_1",
      {
        output: [
          { type: "function_call", call_id: "call_1", name: "shell", arguments: "{\"cmd\":\"printf ok\"}" },
        ],
      },
    ],
  ]);
  const messages = messagesFromResponsesInput(
    {
      previous_response_id: "resp_1",
      input: [{ type: "function_call_output", call_id: "call_1", output: "ok" }],
    },
    store,
  );
  assert.equal(messages[0].role, "assistant");
  assert.equal(messages[0].tool_calls[0].function.name, "shell");
  assert.deepEqual(messages[1], { role: "tool", tool_call_id: "call_1", content: "ok" });
});

test("converts Responses function tools to chat completions tools", () => {
  const tools = toolsFromResponsesTools([
    {
      type: "function",
      name: "shell",
      description: "run a command",
      parameters: { type: "object", properties: { cmd: { type: "string" } } },
    },
  ]);
  assert.equal(tools[0].type, "function");
  assert.equal(tools[0].function.name, "shell");
});

test("builds DeepSeek request body with supported knobs only when provided", () => {
  const body = deepseekRequestBody(
    {
      model: "deepseek-v4-flash",
      input: "hello",
      max_output_tokens: 12,
      top_p: 0.8,
      parallel_tool_calls: true,
    },
    undefined,
    true,
  );
  assert.equal(body.model, "deepseek-v4-flash");
  assert.equal(body.stream, true);
  assert.equal(body.max_tokens, 12);
  assert.equal(body.top_p, 0.8);
  assert.equal(body.parallel_tool_calls, true);
});

test("normalizes DeepSeek tool calls into Responses output items", () => {
  const normalized = normalizeDeepSeekMessage(
    {
      tool_calls: [
        {
          id: "call_abc",
          function: { name: "shell", arguments: "{\"cmd\":\"date\"}" },
        },
      ],
    },
    "resp_test",
    1700000000000,
  );
  assert.equal(normalized.output[0].type, "function_call");
  assert.equal(normalized.output[0].call_id, "call_abc");
  assert.equal(normalized.output[0].name, "shell");
});
