export function workspaceIdFromUrl(): string {
  return typeof location === 'undefined'
    ? 'default'
    : (new URLSearchParams(location.search).get('workspace') ?? 'default');
}

export function workspaceApiBase(workspaceId = workspaceIdFromUrl()): string {
  return workspaceId === 'default' ? '/api' : `/api/workspaces/${encodeURIComponent(workspaceId)}`;
}
