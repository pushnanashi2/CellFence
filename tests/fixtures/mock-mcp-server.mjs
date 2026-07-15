import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const logPath = process.env.MOCK_MCP_LOG;

function writeResponse(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function recordCall(params) {
  if (!logPath) return;
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${JSON.stringify({ name: params.name, arguments: params.arguments || {} })}\n`);
}

const input = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

input.on("line", (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  if (!("id" in request)) return;
  if (request.method === "initialize") {
    writeResponse({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "mock-mcp", version: "1.0.0" },
      },
    });
    return;
  }
  if (request.method === "tools/list") {
    writeResponse({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        tools: [
          {
            name: "read_file",
            description: "Read a file",
            inputSchema: { type: "object", properties: { path: { type: "string" } } },
          },
          {
            name: "write_file",
            description: "Write a file",
            inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } },
          },
        ],
      },
    });
    return;
  }
  if (request.method === "tools/call") {
    recordCall(request.params);
    writeResponse({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        content: [{ type: "text", text: `called ${request.params.name}` }],
      },
    });
    return;
  }
  writeResponse({
    jsonrpc: "2.0",
    id: request.id,
    error: { code: -32601, message: `unknown method ${request.method}` },
  });
});
