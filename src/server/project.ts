import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { ToolError } from '../engine/scene.js';

const jsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);
export const projectSchema = z
  .object({
    kind: z.literal('fieldwork-project'),
    schema_version: z.literal(1),
    project_id: z.string().uuid(),
    info_revision: z.number().int().nonnegative(),
    goal: z.string().max(2000),
    main_session: z.string().uuid(),
    agent_context: z.record(z.string(), jsonValue),
  })
  .strict();
export type ProjectInfo = z.infer<typeof projectSchema>;

export class ProjectStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly root: string) {}
  get file(): string {
    return path.join(this.root, 'info.yaml');
  }

  static async initialize(root: string): Promise<ProjectStore> {
    const resolved = path.resolve(root);
    const store = new ProjectStore(resolved);
    let existing;
    try {
      existing = await lstat(resolved);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (!existing) {
      await mkdir(resolved, { recursive: true });
      const main = randomUUID();
      await store.atomicWrite({
        kind: 'fieldwork-project',
        schema_version: 1,
        project_id: randomUUID(),
        info_revision: 0,
        goal: '',
        main_session: main,
        agent_context: {},
      });
      await mkdir(path.join(resolved, `session-${main}`));
    } else if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new ToolError('INVALID_PROJECT', `Workdir '${resolved}' must be a directory.`);
    }
    const info = await store.read();
    const sessionDir = path.join(resolved, `session-${info.main_session}`);
    const sessionStat = await lstat(sessionDir).catch(() => null);
    if (!sessionStat?.isDirectory() || sessionStat.isSymbolicLink())
      throw new ToolError(
        'INVALID_PROJECT',
        `Main session directory '${sessionDir}' is missing or invalid.`,
      );
    return store;
  }

  async read(): Promise<ProjectInfo> {
    try {
      const stat = await lstat(this.file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not a regular file');
      const source = await readFile(this.file, 'utf8');
      return projectSchema.parse(YAML.parse(source, { uniqueKeys: true }));
    } catch (error) {
      throw new ToolError(
        'INVALID_PROJECT',
        `Workdir '${this.root}' is not a valid Fieldwork project: ${String(error)}`,
      );
    }
  }

  async update(input: {
    expectedRevision: number;
    goal?: string;
    agentContext?: Record<string, unknown>;
  }): Promise<ProjectInfo> {
    const task = this.queue.then(async () => {
      const previous = await this.read();
      if (previous.info_revision !== input.expectedRevision)
        throw new ToolError(
          'PROJECT_REVISION_CONFLICT',
          `Project info is at revision ${previous.info_revision}; reread it before updating.`,
        );
      if (input.goal === undefined && input.agentContext === undefined)
        throw new ToolError('INVALID_PROJECT_UPDATE', 'Provide goal or agentContext.');
      const next = projectSchema.parse({
        ...previous,
        info_revision: previous.info_revision + 1,
        ...(input.goal !== undefined ? { goal: input.goal.trim() } : {}),
        ...(input.agentContext !== undefined ? { agent_context: input.agentContext } : {}),
      });
      await this.atomicWrite(next);
      return next;
    });
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async atomicWrite(value: ProjectInfo): Promise<void> {
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, YAML.stringify(value), { mode: 0o600 });
      await rename(temp, this.file);
    } finally {
      await rm(temp, { force: true });
    }
  }
}
