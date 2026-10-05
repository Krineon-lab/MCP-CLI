#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { SERVER_NAME, VERSION } from "./config.js";
import { registerTools } from "./tools.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "rob-desktop-commander",
    version: VERSION
  });
  registerTools(server);
  return server;
}

void serveStdio(createServer);
console.error(`${SERVER_NAME} v${VERSION} running on stdio (PID ${process.pid})`);
