#!/usr/bin/env node
import { createAdapterServer } from "../src/server.js";

const adapter = createAdapterServer();
const { host, port } = await adapter.listen();

console.error(`Codex DeepSeek Responses adapter listening on http://${host}:${port}`);
