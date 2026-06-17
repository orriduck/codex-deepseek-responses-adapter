#!/usr/bin/env node
import { createAdapterServer } from "../src/server.js";

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--host" && next) {
      options.host = next;
      index += 1;
    } else if (arg === "--port" && next) {
      options.port = Number(next);
      index += 1;
    } else if (arg === "--deepseek-base-url" && next) {
      options.deepseekBaseUrl = next;
      index += 1;
    } else if (arg === "--default-model" && next) {
      options.defaultModel = next;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: codex-deepseek-responses-adapter [options]

Options:
  --host <host>                    Listen host, default 127.0.0.1
  --port <port>                    Listen port, default 48765
  --deepseek-base-url <url>        DeepSeek API base URL
  --default-model <model>          Default model, default deepseek-v4-pro
  -h, --help                       Show this help
`);
      process.exit(0);
    }
  }
  return options;
}

const adapter = createAdapterServer(parseArgs(process.argv.slice(2)));
const { host, port } = await adapter.listen();

console.error(`Codex DeepSeek Responses adapter listening on http://${host}:${port}`);
