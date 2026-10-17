import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const processes = [];
const quiet = { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] };

function run(command, args) {
  const result = spawnSync(command, args, quiet);
  if (result.error || result.status !== 0)
    throw new Error(
      `${command} ${args.join(' ')} failed. ${result.error ?? `exit ${result.status}`}`,
    );
}

async function ready(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(800) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitFor(urls, timeoutMs = 120_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if ((await Promise.all(urls.map(ready))).every(Boolean)) return;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(
    `Fieldwork did not become ready at ${urls.join(' and ')}. Check local port use and npm output.`,
  );
}

function start(command, args) {
  const child = spawn(command, args, { ...quiet, windowsHide: true });
  processes.push(child);
  child.on('error', (error) => process.stderr.write(`Fieldwork process error: ${error.message}\n`));
  return child;
}

function stopProcesses() {
  for (const child of processes) if (child.exitCode === null) child.kill('SIGTERM');
}

async function openBrowser() {
  if (process.env.FIELDWORK_NO_OPEN === '1' || process.env.CI) return;
  const url = `http://127.0.0.1:${process.env.VITE_PORT ?? '5173'}`;
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { ...quiet, windowsHide: true }).unref();
    return;
  }
  const child = spawn(command, [url], { ...quiet, windowsHide: true });
  child.on('error', () => {});
  child.unref();
}

try {
  if (
    !existsSync(path.join(root, 'node_modules', '.bin', 'tsx')) ||
    !existsSync(path.join(root, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json'))
  ) {
    process.stderr.write('Fresh clone detected; installing project dependencies…\n');
    run('npm', ['ci']);
  }

  const browserPath = execFileSync(
    process.execPath,
    ['-e', "process.stdout.write(require('playwright').chromium.executablePath())"],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
  if (!existsSync(browserPath.trim())) {
    process.stderr.write('Installing the Playwright Chromium browser…\n');
    run('npx', ['playwright', 'install', 'chromium']);
  }

  const apiBase = process.env.SCENE_API ?? `http://127.0.0.1:${process.env.PORT ?? '3001'}`;
  const webBase = `http://127.0.0.1:${process.env.VITE_PORT ?? '5173'}`;
  const apiUrl = `${apiBase}/api/health`;
  const webUrl = webBase;
  const hasApi = await ready(apiUrl);
  const hasWeb = await ready(webUrl);
  if (!hasApi && !hasWeb) {
    start('npm', ['run', 'dev']);
  } else {
    if (!hasApi) start('npm', ['run', 'api']);
    if (!hasWeb) start('npm', ['run', 'web']);
  }
  await waitFor([apiUrl, webUrl]);
  await openBrowser();

  const mcp = spawn(process.execPath, ['--import', 'tsx', 'src/server/mcp.ts'], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  });
  mcp.on('error', (error) => {
    process.stderr.write(`Cannot start Fieldwork MCP server: ${error.message}\n`);
    stopProcesses();
    process.exitCode = 1;
  });
  mcp.on('exit', (code, signal) => {
    stopProcesses();
    process.exitCode = code ?? (signal ? 1 : 0);
  });
  process.on('SIGINT', () => {
    stopProcesses();
    mcp.kill('SIGINT');
  });
  process.on('SIGTERM', () => {
    stopProcesses();
    mcp.kill('SIGTERM');
  });
} catch (error) {
  stopProcesses();
  process.stderr.write(`Fieldwork setup failed: ${String(error)}\n`);
  process.exitCode = 1;
}
