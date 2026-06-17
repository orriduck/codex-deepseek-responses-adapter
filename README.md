# Codex DeepSeek Responses Adapter

A local Node.js adapter that lets Codex talk to DeepSeek's OpenAI-compatible Chat Completions API through the Responses API shape Codex expects.

Codex currently requires `wire_api = "responses"` for custom providers. DeepSeek exposes Chat Completions, so this adapter translates between the two APIs locally.

## What Works

- `POST /responses` and `POST /v1/responses`
- `GET /responses/:id`, `DELETE /responses/:id`, and `POST /responses/:id/cancel`
- streaming Server-Sent Events
- non-streaming `stream: false`
- text input and output
- function/tool definitions
- tool call streaming back to Codex
- `function_call_output` continuation via `previous_response_id`
- multiple sequential tool calls
- basic `text.format` to `response_format` mapping for JSON responses
- `GET /models`, `GET /v1/models`, and `GET /health`

## Known Limits

- Image and file inputs are represented as text placeholders.
- Reasoning summaries are not supported by DeepSeek through this adapter.
- Native web search, computer use, and other specialized Responses tools are not implemented as first-class DeepSeek capabilities.

## Install

```bash
git clone https://github.com/orriduck/codex-deepseek-responses-adapter.git
cd codex-deepseek-responses-adapter
npm test
npm start
```

By default the adapter listens on `127.0.0.1:48765`.

Optional environment variables:

```bash
DEEPSEEK_PROXY_HOST=127.0.0.1
DEEPSEEK_PROXY_PORT=48765
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_DEFAULT_MODEL=deepseek-v4-pro
DEEPSEEK_MAX_STORED_RESPONSES=50
```

## Codex Profile

Create `~/.codex/deepseek.config.toml`:

```toml
model = "deepseek-v4-pro"
model_provider = "deepseek"
model_reasoning_effort = "high"

[model_providers.deepseek]
name = "DeepSeek via local Responses adapter"
base_url = "http://127.0.0.1:48765"
wire_api = "responses"
env_key = "DEEPSEEK_API_KEY"
```

Then:

```bash
export DEEPSEEK_API_KEY="..."
codex --profile deepseek
```

## macOS LaunchAgent

Use `launchd/com.example.codex.deepseek-responses-adapter.plist` as a template. Replace the Node path and repository path, then load it:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.codex.deepseek-responses-adapter.plist
launchctl enable gui/$(id -u)/com.example.codex.deepseek-responses-adapter
```

## Development

```bash
npm run check
npm test
```
