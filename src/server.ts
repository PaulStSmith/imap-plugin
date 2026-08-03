import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startSetupServer } from "./config/setup-server.js";
import { registerTools } from "./tools/register.js";

await startSetupServer();

const server = new McpServer({
  name: "imap-plugin",
  version: "0.1.0"
});

registerTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
