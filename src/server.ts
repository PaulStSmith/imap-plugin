import { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { handleHostedSetupRequest, startSetupServer } from "./config/setup-server.js";
import { registerTools } from "./tools/register.js";

const SERVER_VERSION = "0.5.0-beta.0";
const DEFAULT_HTTP_PORT = 3000;

type HttpRequest = IncomingMessage & { body?: unknown };
type HttpResponse = ServerResponse & {
  status(code: number): HttpResponse;
  json(body: unknown): void;
};

function createServer(): McpServer {
  const server = new McpServer({
    name: "imap-plugin",
    version: SERVER_VERSION
  });

  registerTools(server);
  return server;
}

async function startStdioServer(): Promise<void> {
  await startSetupServer();
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function startHttpServer(): Promise<void> {
  const app = createMcpExpressApp({ host: "0.0.0.0" });
  const port = Number(process.env.HTTP_PLATFORM_PORT || process.env.PORT || process.env.IMAP_PLUGIN_HTTP_PORT || DEFAULT_HTTP_PORT);

  app.get("/health", (_request: HttpRequest, response: HttpResponse) => {
    response.status(200).json({
      ok: true,
      name: "imap-plugin",
      version: SERVER_VERSION,
      transport: "streamable-http"
    });
  });

  app.get("/", async (request: HttpRequest, response: HttpResponse) => {
    await handleHostedSetupRequest(request, response);
  });

  app.get("/setup", async (request: HttpRequest, response: HttpResponse) => {
    await handleHostedSetupRequest(request, response);
  });

  app.get("/assets/imap-plugin-logo-square.png", async (request: HttpRequest, response: HttpResponse) => {
    await handleHostedSetupRequest(request, response);
  });

  app.options("/api/{*path}", async (request: HttpRequest, response: HttpResponse) => {
    await handleHostedSetupRequest(request, response);
  });

  app.get("/api/{*path}", async (request: HttpRequest, response: HttpResponse) => {
    await handleHostedSetupRequest(request, response);
  });

  app.post("/api/{*path}", async (request: HttpRequest, response: HttpResponse) => {
    await handleHostedSetupRequest(request, response);
  });

  app.delete("/api/{*path}", async (request: HttpRequest, response: HttpResponse) => {
    await handleHostedSetupRequest(request, response);
  });

  app.post("/mcp", async (request: HttpRequest, response: HttpResponse) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
      response.on("close", () => {
        void transport.close();
        void server.close();
      });
    } catch (error) {
      console.error("Error handling MCP request:", error);
      void transport.close();
      void server.close();

      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error"
          },
          id: null
        });
      }
    }
  });

  app.get("/mcp", (_request: HttpRequest, response: HttpResponse) => {
    response.status(405).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed."
      },
      id: null
    });
  });

  app.delete("/mcp", (_request: HttpRequest, response: HttpResponse) => {
    response.status(405).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed."
      },
      id: null
    });
  });

  app.listen(port, "0.0.0.0", (error?: Error) => {
    if (error) {
      console.error("Failed to start IMAP Plugin MCP HTTP server:", error);
      process.exit(1);
    }

    console.log(`IMAP Plugin MCP HTTP server listening on port ${port}`);
  });
}

if (process.env.IMAP_PLUGIN_TRANSPORT === "http") {
  await startHttpServer();
} else {
  await startStdioServer();
}
