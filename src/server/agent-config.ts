import { access, chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { ToolError } from '../engine/scene.js';

async function readRegular(file: string): Promise<string | undefined> {
  const stat = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return undefined;
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new ToolError('AGENT_CONFIG_CONFLICT', `Refusing non-regular config '${file}'.`);
  return readFile(file, 'utf8');
}

async function atomicText(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, text, { mode: 0o600 });
  await rename(temp, file);
}

function parseJsonConfig(file: string, source: string | undefined): Record<string, any> {
  if (!source) return {};
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new ToolError('AGENT_CONFIG_CONFLICT', `Invalid JSON in '${file}'.`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ToolError('AGENT_CONFIG_CONFLICT', `Expected a JSON object in '${file}'.`);
  return value as Record<string, any>;
}

function ensureManaged(entry: any, file: string, marker: 'env' | 'environment'): void {
  if (entry !== undefined && entry?.[marker]?.FIELDWORK_MANAGED !== '1')
    throw new ToolError(
      'AGENT_CONFIG_CONFLICT',
      `An unmanaged fieldwork MCP entry already exists in '${file}'.`,
    );
}

export async function refreshAgentConfig(
  root: string,
  sessionId: string,
  appRoot: string,
  targetDir = root,
): Promise<void> {
  const mcpScript = path.join(appRoot, 'dist/server/server/mcp.js');
  const env = { FIELDWORK_WORKDIR: root, FIELDWORK_SESSION_ID: sessionId, FIELDWORK_MANAGED: '1' };
  const claudePath = path.join(targetDir, '.mcp.json');
  const claude = parseJsonConfig(claudePath, await readRegular(claudePath));
  if (
    claude.mcpServers !== undefined &&
    (!claude.mcpServers ||
      typeof claude.mcpServers !== 'object' ||
      Array.isArray(claude.mcpServers))
  )
    throw new ToolError('AGENT_CONFIG_CONFLICT', `Invalid mcpServers in '${claudePath}'.`);
  ensureManaged(claude.mcpServers?.fieldwork, claudePath, 'env');
  claude.mcpServers = {
    ...claude.mcpServers,
    fieldwork: { command: process.execPath, args: [mcpScript], env },
  };

  const openCodePath = path.join(targetDir, 'opencode.json');
  const openCode = parseJsonConfig(openCodePath, await readRegular(openCodePath));
  if (
    openCode.mcp !== undefined &&
    (!openCode.mcp || typeof openCode.mcp !== 'object' || Array.isArray(openCode.mcp))
  )
    throw new ToolError('AGENT_CONFIG_CONFLICT', `Invalid mcp in '${openCodePath}'.`);
  ensureManaged(openCode.mcp?.fieldwork, openCodePath, 'environment');
  openCode.mcp = {
    ...openCode.mcp,
    fieldwork: {
      type: 'local',
      command: [process.execPath, mcpScript],
      environment: env,
      enabled: true,
    },
  };

  const codexPath = path.join(targetDir, '.codex/config.toml');
  const codexSource = (await readRegular(codexPath)) ?? '';
  const start = '# BEGIN FIELDWORK MANAGED';
  const end = '# END FIELDWORK MANAGED';
  let codexBase = codexSource;
  if (codexSource.includes(start) || codexSource.includes(end)) {
    const first = codexSource.indexOf(start);
    const last = codexSource.indexOf(end);
    if (
      first < 0 ||
      last < first ||
      codexSource.indexOf(start, first + 1) >= 0 ||
      codexSource.indexOf(end, last + 1) >= 0
    )
      throw new ToolError('AGENT_CONFIG_CONFLICT', `Broken Fieldwork block in '${codexPath}'.`);
    codexBase = codexSource.slice(0, first) + codexSource.slice(last + end.length);
  }
  try {
    parseToml(codexBase);
  } catch {
    throw new ToolError('AGENT_CONFIG_CONFLICT', `Invalid TOML in '${codexPath}'.`);
  }
  if (/^\s*\[mcp_servers\.fieldwork(?:\.|\])/m.test(codexBase))
    throw new ToolError(
      'AGENT_CONFIG_CONFLICT',
      `An unmanaged fieldwork MCP entry already exists in '${codexPath}'.`,
    );
  const block = [
    start,
    '[mcp_servers.fieldwork]',
    `command = ${JSON.stringify(process.execPath)}`,
    `args = [${JSON.stringify(mcpScript)}]`,
    '[mcp_servers.fieldwork.env]',
    ...Object.entries(env).map(([key, value]) => `${key} = ${JSON.stringify(value)}`),
    end,
  ].join('\n');
  const codex = `${codexBase.trimEnd()}${codexBase.trim() ? '\n\n' : ''}${block}\n`;
  try {
    parseToml(codex);
  } catch {
    throw new ToolError('AGENT_CONFIG_CONFLICT', `Cannot generate Codex config '${codexPath}'.`);
  }

  await atomicText(claudePath, JSON.stringify(claude, null, 2) + '\n');
  await atomicText(openCodePath, JSON.stringify(openCode, null, 2) + '\n');
  await atomicText(codexPath, codex);
}

export async function installSessionCommand(root: string, appRoot: string): Promise<void> {
  const command = path.join(root, '.fieldwork/bin/fieldwork');
  const script = path.join(appRoot, 'dist/server/server/session-cli.js');
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  await atomicText(
    command,
    `#!/bin/sh\nFIELDWORK_WORKDIR=${quote(root)} exec ${quote(process.execPath)} ${quote(script)} "$@"\n`,
  );
  await chmod(command, 0o700);
  let codexBin: string | undefined;
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(directory, 'codex');
    try {
      await access(candidate, constants.X_OK);
      codexBin = candidate;
      break;
    } catch {
      /* Keep searching. */
    }
  }
  if (codexBin) {
    const mcpScript = path.join(appRoot, 'dist/server/server/mcp.js');
    const overrides = [
      `mcp_servers.fieldwork.command=${JSON.stringify(process.execPath)}`,
      `mcp_servers.fieldwork.args=[${JSON.stringify(mcpScript)}]`,
      `mcp_servers.fieldwork.env.FIELDWORK_WORKDIR=${JSON.stringify(root)}`,
      'mcp_servers.fieldwork.env.FIELDWORK_MANAGED="1"',
    ]
      .map((value) => `-c ${quote(value)}`)
      .join(' ');
    const wrapper = path.join(root, '.fieldwork/bin/codex');
    await atomicText(
      wrapper,
      `#!/bin/sh\n: "${'${FIELDWORK_SESSION_ID:?Fieldwork session binding is missing}'}"\nexec ${quote(codexBin)} ${overrides} -c "mcp_servers.fieldwork.env.FIELDWORK_SESSION_ID=\\"$FIELDWORK_SESSION_ID\\"" "$@"\n`,
    );
    await chmod(wrapper, 0o700);
  }
}
