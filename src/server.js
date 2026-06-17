import http from "node:http";
import {
  buildModelEntry,
  deepseekRequestBody,
  normalizeDeepSeekMessage,
} from "./adapter.js";

const DEFAULT_MODELS = [
  ["deepseek-v4-pro", "DeepSeek V4 Pro"],
  ["deepseek-v4-flash", "DeepSeek V4 Flash"],
];

function responseId() {
  return `resp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function itemId(prefix, index = "") {
  return `${prefix}_${Date.now().toString(36)}${index === "" ? "" : `_${index}`}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function sse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sanitizeHeaders(headers) {
  const result = {
    "content-type": "application/json",
  };
  if (headers.authorization) result.authorization = headers.authorization;
  return result;
}

export function createAdapterServer(options = {}) {
  const port = Number(options.port || process.env.DEEPSEEK_PROXY_PORT || 48765);
  const host = options.host || process.env.DEEPSEEK_PROXY_HOST || "127.0.0.1";
  const deepseekBaseUrl = options.deepseekBaseUrl || process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
  const defaultModel = options.defaultModel || process.env.DEEPSEEK_DEFAULT_MODEL || "deepseek-v4-pro";
  const maxStoredResponses = Number(options.maxStoredResponses || process.env.DEEPSEEK_MAX_STORED_RESPONSES || 50);
  const responseStore = new Map();

  function rememberResponse(id, output) {
    responseStore.set(id, { output });
    while (responseStore.size > maxStoredResponses) {
      const oldestKey = responseStore.keys().next().value;
      responseStore.delete(oldestKey);
    }
  }

  async function requestDeepSeek(body, auth, stream) {
    return await fetch(`${deepseekBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: auth,
        "content-type": "application/json",
      },
      body: JSON.stringify(deepseekRequestBody({ model: defaultModel, ...body }, responseStore, stream)),
    });
  }

  async function handleNonStreamingResponse(body, auth, res) {
    const upstream = await requestDeepSeek(body, auth, false);
    if (!upstream.ok) {
      const text = await upstream.text();
      return sendJson(res, upstream.status, { error: { message: text || upstream.statusText } });
    }

    const payload = await upstream.json();
    const id = responseId();
    const normalized = normalizeDeepSeekMessage(payload.choices?.[0]?.message || {}, id);
    rememberResponse(id, normalized.output);
    return sendJson(res, 200, {
      ...normalized,
      model: body.model || defaultModel,
      usage: payload.usage || null,
    });
  }

  async function handleStreamingResponse(body, auth, res) {
    const upstream = await requestDeepSeek(body, auth, true);
    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text();
      return sendJson(res, upstream.status, { error: { message: text || upstream.statusText } });
    }

    const id = responseId();
    let outputId = itemId("msg");
    const createdAt = Math.floor(Date.now() / 1000);
    let outputText = "";
    const toolCalls = new Map();
    let textStarted = false;
    let textOutputIndex = null;
    let nextOutputIndex = 0;
    const completedOutput = [];

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    const baseResponse = {
      id,
      object: "response",
      created_at: createdAt,
      status: "in_progress",
      model: body.model || defaultModel,
      output: [],
    };
    sse(res, "response.created", { type: "response.created", response: baseResponse });
    sse(res, "response.in_progress", { type: "response.in_progress", response: baseResponse });

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() || "";

      for (const block of blocks) {
        for (const line of block.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          const parsed = JSON.parse(data);
          const choiceDelta = parsed.choices?.[0]?.delta || {};
          const delta = choiceDelta.content;

          if (delta) {
            if (!textStarted) {
              textStarted = true;
              textOutputIndex = nextOutputIndex++;
              outputId = itemId("msg");
              sse(res, "response.output_item.added", {
                type: "response.output_item.added",
                output_index: textOutputIndex,
                item: { id: outputId, type: "message", status: "in_progress", role: "assistant", content: [] },
              });
              sse(res, "response.content_part.added", {
                type: "response.content_part.added",
                item_id: outputId,
                output_index: textOutputIndex,
                content_index: 0,
                part: { type: "output_text", text: "" },
              });
            }
            outputText += delta;
            sse(res, "response.output_text.delta", {
              type: "response.output_text.delta",
              item_id: outputId,
              output_index: textOutputIndex,
              content_index: 0,
              delta,
            });
          }

          for (const toolCallDelta of choiceDelta.tool_calls || []) {
            const index = toolCallDelta.index ?? toolCalls.size;
            let toolCall = toolCalls.get(index);
            if (!toolCall) {
              const callId = toolCallDelta.id || itemId("call", index);
              toolCall = {
                id: itemId("fc", index),
                call_id: callId,
                name: "",
                arguments: "",
                output_index: nextOutputIndex++,
              };
              toolCalls.set(index, toolCall);
              sse(res, "response.output_item.added", {
                type: "response.output_item.added",
                output_index: toolCall.output_index,
                item: {
                  id: toolCall.id,
                  type: "function_call",
                  status: "in_progress",
                  call_id: toolCall.call_id,
                  name: toolCall.name,
                  arguments: "",
                },
              });
            }
            if (toolCallDelta.function?.name) toolCall.name += toolCallDelta.function.name;
            const argsDelta = toolCallDelta.function?.arguments || "";
            if (argsDelta) {
              toolCall.arguments += argsDelta;
              sse(res, "response.function_call_arguments.delta", {
                type: "response.function_call_arguments.delta",
                item_id: toolCall.id,
                output_index: toolCall.output_index,
                delta: argsDelta,
              });
            }
          }
        }
      }
    }

    if (textStarted) {
      sse(res, "response.output_text.done", {
        type: "response.output_text.done",
        item_id: outputId,
        output_index: textOutputIndex,
        content_index: 0,
        text: outputText,
      });
      sse(res, "response.content_part.done", {
        type: "response.content_part.done",
        item_id: outputId,
        output_index: textOutputIndex,
        content_index: 0,
        part: { type: "output_text", text: outputText },
      });
      const messageOutput = {
        id: outputId,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: outputText }],
      };
      sse(res, "response.output_item.done", {
        type: "response.output_item.done",
        output_index: textOutputIndex,
        item: messageOutput,
      });
      completedOutput.push(messageOutput);
    }

    for (const toolCall of [...toolCalls.values()].sort((a, b) => a.output_index - b.output_index)) {
      sse(res, "response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        item_id: toolCall.id,
        output_index: toolCall.output_index,
        arguments: toolCall.arguments,
      });
      const toolOutput = {
        id: toolCall.id,
        type: "function_call",
        status: "completed",
        call_id: toolCall.call_id,
        name: toolCall.name,
        arguments: toolCall.arguments,
      };
      sse(res, "response.output_item.done", {
        type: "response.output_item.done",
        output_index: toolCall.output_index,
        item: toolOutput,
      });
      completedOutput.push(toolOutput);
    }

    if (!textStarted && toolCalls.size === 0) {
      completedOutput.push({
        id: outputId,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "" }],
      });
    }

    rememberResponse(id, completedOutput);
    sse(res, "response.completed", {
      type: "response.completed",
      response: {
        id,
        object: "response",
        created_at: createdAt,
        status: "completed",
        model: body.model || defaultModel,
        output: completedOutput,
        usage: null,
      },
    });
    res.end("data: [DONE]\n\n");
  }

  async function handleResponses(req, res) {
    const body = await readBody(req);
    const auth = req.headers.authorization;
    if (!auth) {
      return sendJson(res, 401, { error: { message: "Missing Authorization header" } });
    }

    if (body.stream === false) {
      return await handleNonStreamingResponse(body, auth, res);
    }

    return await handleStreamingResponse(body, auth, res);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host}`);
      if (req.method === "GET" && url.pathname === "/health") {
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === "GET" && (url.pathname === "/models" || url.pathname === "/v1/models")) {
        return sendJson(res, 200, {
          models: DEFAULT_MODELS.map(([slug, name], index) => buildModelEntry(slug, name, { priority: DEFAULT_MODELS.length - index })),
        });
      }
      if (req.method === "POST" && (url.pathname === "/responses" || url.pathname === "/v1/responses")) {
        return await handleResponses(req, res);
      }
      return sendJson(res, 404, { error: { message: "Not found" } });
    } catch (error) {
      return sendJson(res, 500, { error: { message: error?.message || String(error) } });
    }
  });

  return {
    server,
    host,
    port,
    deepseekBaseUrl,
    listen() {
      return new Promise((resolve) => {
        server.listen(port, host, () => resolve({ host, port }));
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

export function createRequestHandler(options = {}) {
  return createAdapterServer(options).server;
}
