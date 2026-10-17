const [tool, json] = process.argv.slice(2);
if (!tool || tool === '--help') {
  console.log(
    'Usage: npm run --silent tool -- <tool_name> [JSON arguments]\nOmit arguments to read JSON from stdin. Set SCENE_API (default http://127.0.0.1:3001) and SCENE_WORKSPACE_ID (default workspace: default).\nDiscover schemas at /api/tools or /api/workspaces/<id>/tools.',
  );
  process.exit(tool ? 0 : 1);
}
try {
  let input = json;
  if (input === undefined) {
    input = '';
    for await (const chunk of process.stdin) input += String(chunk);
  }
  const arguments_ = JSON.parse(input);
  const api = process.env.SCENE_API ?? 'http://127.0.0.1:3001';
  const workspaceId = process.env.SCENE_WORKSPACE_ID ?? 'default';
  const endpoint = `${api}${workspaceId === 'default' ? '/api/tools' : `/api/workspaces/${encodeURIComponent(workspaceId)}/tools`}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool, arguments: arguments_ }),
    signal: AbortSignal.timeout(45000),
  });
  const result = (await response.json()) as { success: boolean };
  console.log(JSON.stringify(result, null, 2));
  if (!result.success) process.exitCode = 1;
} catch (error) {
  console.error(
    JSON.stringify({ success: false, error: { code: 'CLIENT_ERROR', message: String(error) } }),
  );
  process.exitCode = 1;
}
