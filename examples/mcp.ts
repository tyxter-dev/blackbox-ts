import { MCPClient, MCPServer, inProcessMCPTransport, mcpToolDefinitions } from 'blackbox-ts/mcp';

const server = new MCPServer('example', [{ name: 'ping', handler: () => 'pong' }]);
const client = new MCPClient(
  { name: 'example', transport: 'stdio', trusted: true },
  inProcessMCPTransport(server),
);
console.log(await mcpToolDefinitions(client));
