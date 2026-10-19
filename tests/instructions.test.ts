import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { toolSchemas } from '../src/shared/schema.js';
import { createFieldworkMcpServer, fieldworkInstructions } from '../src/server/mcp-server.js';
import {
  designerToolTopics,
  instructionFiles,
  leadOverview,
  readInstructionTopic,
  routeTopics,
  toolTopics,
} from '../src/server/instructions.js';

const words = (value: string) => value.trim().split(/\s+/).length;

describe('instruction architecture', () => {
  it('keeps automatic overviews short and links to every reachable topic', async () => {
    expect(words(leadOverview)).toBeLessThanOrEqual(200);
    expect(words(fieldworkInstructions)).toBeLessThanOrEqual(200);
    const index = await readInstructionTopic('index');
    expect(words(index)).toBeLessThanOrEqual(400);
    for (const topic of Object.keys(instructionFiles).filter((name) => name !== 'index')) {
      expect(index).toContain(`/api/instructions/${topic}`);
      expect(
        (await readInstructionTopic(topic as keyof typeof instructionFiles)).length,
      ).toBeGreaterThan(100);
    }
  });

  it('explains primitive placement pitfalls surfaced by room planning', async () => {
    const scene = await readInstructionTopic('scene');
    expect(scene).toContain('Object **names** can contain spaces');
    expect(scene).toContain('catalog IDs, not object names');
    expect(scene).toContain('wall from separate box segments around the opening');
  });

  it('requires a topic and named guidance for every scene and designer MCP tool', async () => {
    expect(Object.keys(toolTopics).sort()).toEqual(Object.keys(toolSchemas).sort());
    const knownGuides = new Set(Object.keys(instructionFiles));
    for (const [tool, topic] of Object.entries({ ...toolTopics, ...designerToolTopics })) {
      expect(knownGuides.has(topic)).toBe(true);
      expect(await readInstructionTopic(topic)).toContain(`\`${tool}\``);
    }
    expect(await readInstructionTopic('index')).toContain('`get_instruction_guide`');
    const server = createFieldworkMcpServer({
      api: 'http://127.0.0.1:1',
      workspaceId: '00000000-0000-4000-8000-000000000001',
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'instruction-catalog-test', version: '1.0.0' });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual(
        [
          ...Object.keys(toolTopics),
          ...Object.keys(designerToolTopics),
          'get_instruction_guide',
        ].sort(),
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('classifies every registered HTTP route and links agent-facing routes to a guide', async () => {
    const source = await readFile(path.resolve('src/server/app.ts'), 'utf8');
    const calls = [...source.matchAll(/\b(?:app|router)\.(?:get|post|patch|delete|put)\s*\(/g)];
    const matches = [
      ...source.matchAll(/\b(app|router)\.(get|post|patch|delete|put)\s*\(\s*['"]([^'"]+)['"]/g),
    ];
    expect(matches).toHaveLength(calls.length);
    const found = new Set(
      matches.map((match) => `${match[1]} ${match[2].toUpperCase()} ${match[3]}`),
    );
    expect([...found].sort()).toEqual(Object.keys(routeTopics).sort());
    for (const [route, topic] of Object.entries(routeTopics)) {
      if (topic === 'internal') continue;
      const [, method, registrationPath] = route.split(' ');
      const publicPath = route.startsWith('router ') ? `/api${registrationPath}` : registrationPath;
      expect(await readInstructionTopic(topic)).toContain(`\`${method} ${publicPath}\``);
    }
  });
});
