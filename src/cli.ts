const [tool, json] = process.argv.slice(2);
if (!tool || tool === '--help') {
  console.log(
    'Usage: SCENE_WORKSPACE_ID=<uuid> npm run --silent tool -- <tool_name> [JSON arguments]\nOmit arguments to read JSON from stdin. Set SCENE_API (default http://127.0.0.1:3001).\nCreate a workspace with `npm run workspace -- create --name "..." --goal "..."`. Discover schemas at /api/workspaces/<id>/tools.',
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
  const workspaceId = process.env.SCENE_WORKSPACE_ID;
  if (
    !workspaceId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workspaceId)
  ) {
    throw new Error(
      'SCENE_WORKSPACE_ID must be a workspace UUID. Create one with `npm run workspace -- create --name "..." --goal "..."`; setup can use DATA_DIR without a running API.',
    );
  }
  const endpoint = `${api}/api/workspaces/${encodeURIComponent(workspaceId)}/tools`;
  const workspaceResponse = await fetch(
    `${api}/api/workspaces/${encodeURIComponent(workspaceId)}`,
    {
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!workspaceResponse.ok) {
    const payload = (await workspaceResponse.json()) as { error?: unknown };
    console.log(JSON.stringify({ success: false, error: payload.error ?? payload }, null, 2));
    process.exitCode = 1;
  } else {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool, arguments: arguments_ }),
      signal: AbortSignal.timeout(45000),
    });
    const result = (await response.json()) as { success: boolean };
    console.log(JSON.stringify(result, null, 2));
    if (!result.success) process.exitCode = 1;
  }
} catch (error) {
  console.error(
    JSON.stringify({ success: false, error: { code: 'CLIENT_ERROR', message: String(error) } }),
  );
  process.exitCode = 1;
}
