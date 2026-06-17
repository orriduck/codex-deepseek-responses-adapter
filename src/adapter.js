const DEFAULT_MODEL = "deepseek-v4-pro";

export function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part?.text) return part.text;
      if (part?.type === "input_text" && part.text) return part.text;
      if (part?.type === "output_text" && part.text) return part.text;
      if (part?.type === "refusal" && part.refusal) return part.refusal;
      if (part?.type === "input_image") return "[image input omitted: DeepSeek text adapter]";
      if (part?.type === "input_file") return "[file input omitted: DeepSeek text adapter]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function responseInputItems(body, responseStore) {
  const items = [];
  if (body.previous_response_id && responseStore?.has(body.previous_response_id)) {
    items.push(...responseStore.get(body.previous_response_id).output);
  }

  const input = body.input;
  if (typeof input === "string") {
    items.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    items.push(...input);
  } else if (input) {
    items.push(input);
  }

  return items;
}

function normalizeToolMessageContent(output) {
  if (typeof output === "string") return output;
  return textFromContent(output) || JSON.stringify(output ?? "");
}

export function messagesFromResponsesInput(body, responseStore) {
  const messages = [];
  if (body.instructions) {
    messages.push({ role: "system", content: String(body.instructions) });
  }

  for (const item of responseInputItems(body, responseStore)) {
    if (typeof item === "string") {
      messages.push({ role: "user", content: item });
      continue;
    }

    if (item?.type === "message") {
      const role = item.role === "assistant" || item.role === "system" ? item.role : "user";
      const content = textFromContent(item.content);
      if (content) {
        const message = { role, content };
        if (role === "assistant" && item.reasoning_content) message.reasoning_content = item.reasoning_content;
        messages.push(message);
      }
      continue;
    }

    if (item?.type === "function_call") {
      const message = {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: item.call_id,
            type: "function",
            function: {
              name: item.name,
              arguments: item.arguments || "",
            },
          },
        ],
      };
      if (item.reasoning_content) message.reasoning_content = item.reasoning_content;
      messages.push(message);
      continue;
    }

    if (item?.type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: item.call_id,
        content: normalizeToolMessageContent(item.output),
      });
      continue;
    }

    if (item?.type === "reasoning") {
      continue;
    }

    const role = item?.role === "assistant" || item?.role === "system" || item?.role === "tool" ? item.role : "user";
    const content = textFromContent(item?.content);
    if (content) messages.push({ role, content });
  }

  if (messages.length === 0) {
    messages.push({ role: "user", content: "" });
  }

  return messages;
}

export function toolsFromResponsesTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const converted = tools
    .filter((tool) => tool?.type === "function" && (tool.name || tool.function?.name))
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name || tool.function.name,
        description: tool.description || tool.function?.description || "",
        parameters: tool.parameters || tool.function?.parameters || { type: "object", properties: {} },
      },
    }));
  return converted.length > 0 ? converted : undefined;
}

export function toolChoiceFromResponsesToolChoice(toolChoice) {
  if (!toolChoice || typeof toolChoice === "string") return toolChoice;
  if (toolChoice.type === "function" && toolChoice.name) {
    return { type: "function", function: { name: toolChoice.name } };
  }
  if (toolChoice.type === "function" && toolChoice.function?.name) {
    return { type: "function", function: { name: toolChoice.function.name } };
  }
  return undefined;
}

export function deepseekRequestBody(body, responseStore, stream) {
  const requestBody = {
    model: body.model || DEFAULT_MODEL,
    messages: messagesFromResponsesInput(body, responseStore),
    stream,
  };
  const tools = toolsFromResponsesTools(body.tools);
  const toolChoice = toolChoiceFromResponsesToolChoice(body.tool_choice);
  if (tools) requestBody.tools = tools;
  if (toolChoice) requestBody.tool_choice = toolChoice;
  if (body.temperature !== undefined) requestBody.temperature = body.temperature;
  if (body.top_p !== undefined) requestBody.top_p = body.top_p;
  if (body.max_output_tokens !== undefined) requestBody.max_tokens = body.max_output_tokens;
  if (body.parallel_tool_calls !== undefined) requestBody.parallel_tool_calls = body.parallel_tool_calls;
  if (body.stop !== undefined) requestBody.stop = body.stop;
  if (stream) requestBody.stream_options = { include_usage: true };
  const textFormat = body.text?.format;
  if (textFormat?.type === "json_object") {
    requestBody.response_format = { type: "json_object" };
  } else if (textFormat?.type === "json_schema") {
    requestBody.response_format = {
      type: "json_schema",
      json_schema: textFormat.schema ? { name: textFormat.name || "response", schema: textFormat.schema } : textFormat.json_schema,
    };
  }
  return requestBody;
}

export function buildModelEntry(slug, displayName, options = {}) {
  const reasoningLevels = [
    { effort: "low", description: "Faster responses" },
    { effort: "medium", description: "Balanced responses" },
    { effort: "high", description: "Deeper responses" },
  ];
  const baseInstructions = "You are Codex, a coding agent. Follow the user's instructions and be concise.";
  return {
    slug,
    display_name: displayName,
    description: "DeepSeek via local Responses API adapter",
    default_reasoning_level: "medium",
    supported_reasoning_levels: reasoningLevels,
    shell_type: "shell_command",
    supported_in_api: true,
    priority: options.priority ?? 1,
    base_instructions: baseInstructions,
    model_messages: {
      instructions_template: "{{ personality }}\n\nYou are Codex, a coding agent. Follow the user's instructions and be concise.",
    },
    supports_reasoning_summaries: false,
    default_reasoning_summary: "none",
    supports_parallel_tool_calls: true,
    support_verbosity: false,
    default_verbosity: "medium",
    apply_patch_tool_type: "freeform",
    web_search_tool_type: "text_and_image",
    truncation_policy: { mode: "tokens", limit: options.truncationLimit ?? 10000 },
    supports_image_detail_original: false,
    context_window: options.contextWindow ?? 64000,
    max_context_window: options.contextWindow ?? 64000,
    comp_hash: "deepseek-proxy",
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: ["text"],
    supports_search_tool: false,
    use_responses_lite: false,
    visibility: "list",
  };
}

export function normalizeDeepSeekMessage(message, responseId, now = Date.now()) {
  const output = [];
  if (message.content) {
    output.push({
      id: `msg_${now.toString(36)}`,
      type: "message",
      status: "completed",
      role: "assistant",
      reasoning_content: message.reasoning_content,
      content: [{ type: "output_text", text: message.content }],
    });
  }
  for (const [index, toolCall] of (message.tool_calls || []).entries()) {
    output.push({
      id: `fc_${now.toString(36)}_${index}`,
      type: "function_call",
      status: "completed",
      call_id: toolCall.id,
      name: toolCall.function?.name || "",
      arguments: toolCall.function?.arguments || "",
      reasoning_content: message.reasoning_content,
    });
  }
  return {
    id: responseId,
    object: "response",
    created_at: Math.floor(now / 1000),
    status: "completed",
    output,
  };
}

export function publicResponseOutput(output) {
  return output.map(({ reasoning_content, ...item }) => item);
}

export function normalizeUsage(usage) {
  if (!usage) return null;
  const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? usage.completion_tokens ?? 0;
  const totalTokens = usage.total_tokens ?? inputTokens + outputTokens;
  const cachedTokens = usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
  const reasoningTokens = usage.output_tokens_details?.reasoning_tokens ?? usage.completion_tokens_details?.reasoning_tokens ?? 0;
  return {
    input_tokens: inputTokens,
    input_tokens_details: {
      cached_tokens: cachedTokens,
    },
    output_tokens: outputTokens,
    output_tokens_details: {
      reasoning_tokens: reasoningTokens,
    },
    total_tokens: totalTokens,
  };
}
