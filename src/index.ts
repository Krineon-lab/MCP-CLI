#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { SERVER_NAME, VERSION } from "./config.js";
import { registerTools } from "./tools.js";
import { logger } from "./logger.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "rob-desktop-commander",
    version: VERSION
  });
  registerTools(server);
  return server;
}

logger.info("server.starting", { name: SERVER_NAME, version: VERSION, pid: process.pid });
void serveStdio(createServer);
console.error(`${SERVER_NAME} v${VERSION} running on stdio (PID ${process.pid})`);

process.once("beforeExit", () => {
  void logger.flush();
});
