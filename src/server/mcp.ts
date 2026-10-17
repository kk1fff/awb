import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createFieldworkMcpServer } from './mcp-server.js';

const server = createFieldworkMcpServer();
await server.connect(new StdioServerTransport());
