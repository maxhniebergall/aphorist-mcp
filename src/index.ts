#!/usr/bin/env node

/**
 * Aphorist MCP Server — entry point.
 * Runs over stdio transport for use with Claude Desktop, MCP Inspector, etc.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

async function main() {
  const { server } = createServer();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write("Aphorist MCP server running on stdio\n");
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err}\n`);
  process.exit(1);
});
