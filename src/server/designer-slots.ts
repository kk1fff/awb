import { randomUUID } from 'node:crypto';
import { ToolError } from '../engine/scene.js';
import type { WorkspaceManager } from './workspaces.js';

export type DesignerState =
  'reserved' | 'opening' | 'active' | 'awaiting_confirmation' | 'closed' | 'aborted';
export type DesignerSlot = {
  reservationId: string;
  task: string;
  state: DesignerState;
  sessionId?: string;
  summary?: string;
  reason?: string;
  createdAt: string;
  updatedAt: string;
};

export class DesignerSlots {
  private readonly slots = new Map<string, DesignerSlot>();
  constructor(
    readonly limit: number,
    private readonly workspaces: WorkspaceManager,
    private readonly mainSessionId: string,
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new ToolError(
        'INVALID_CONCURRENCY',
        'Concurrent designers must be a positive integer.',
      );
  }

  status() {
    const reservations = [...this.slots.values()].map((slot) => ({ ...slot }));
    const used =
      1 + reservations.filter((slot) => !['closed', 'aborted'].includes(slot.state)).length;
    return { limit: this.limit, used, available: this.limit - used, reservations };
  }

  reserve(task: string): DesignerSlot {
    if (!task.trim() || task.length > 2000)
      throw new ToolError('INVALID_DESIGNER_TASK', 'Provide a task of 1–2000 characters.');
    if (this.status().available < 1)
      throw new ToolError(
        'DESIGNER_LIMIT_REACHED',
        `All ${this.limit} designer slots are occupied.`,
      );
    const now = new Date().toISOString();
    const slot: DesignerSlot = {
      reservationId: randomUUID(),
      task: task.trim(),
      state: 'reserved',
      createdAt: now,
      updatedAt: now,
    };
    this.slots.set(slot.reservationId, slot);
    return { ...slot };
  }

  async open(
    reservationId: string,
    name: string,
    goal: string,
    existingSessionId?: string,
  ): Promise<DesignerSlot> {
    const slot = this.require(reservationId);
    if (slot.state === 'active') return { ...slot };
    if (slot.state !== 'reserved')
      throw new ToolError('DESIGNER_STATE_CONFLICT', `Reservation is ${slot.state}.`);
    slot.state = 'opening';
    slot.updatedAt = new Date().toISOString();
    try {
      if (existingSessionId) {
        if (existingSessionId === this.mainSessionId)
          throw new ToolError(
            'MAIN_SESSION_RESERVED',
            'The main session belongs to the lead designer.',
          );
        if (
          [...this.slots.values()].some(
            (entry) =>
              entry.sessionId === existingSessionId && !['closed', 'aborted'].includes(entry.state),
          )
        )
          throw new ToolError('DESIGNER_STATE_CONFLICT', 'Session already has a designer slot.');
        const existing = await this.workspaces.describe(existingSessionId);
        if (existing.workspaceStatus !== 'active')
          throw new ToolError('WORKSPACE_ARCHIVED', 'Restore this session before continuing.');
        slot.sessionId = existingSessionId;
      } else {
        const workspace = await this.workspaces.create({ name, goal });
        slot.sessionId = workspace.id;
      }
      slot.state = 'active';
      slot.updatedAt = new Date().toISOString();
      return { ...slot };
    } catch (error) {
      slot.state = 'reserved';
      slot.updatedAt = new Date().toISOString();
      throw error;
    }
  }

  complete(sessionId: string, summary: string): DesignerSlot {
    const slot = this.bySession(sessionId);
    if (slot.state !== 'active')
      throw new ToolError('DESIGNER_STATE_CONFLICT', `Session is ${slot.state}.`);
    if (!summary.trim())
      throw new ToolError('INVALID_DESIGNER_SUMMARY', 'Provide a completion summary.');
    slot.summary = summary.trim();
    slot.state = 'awaiting_confirmation';
    slot.updatedAt = new Date().toISOString();
    return { ...slot };
  }

  confirm(sessionId: string): DesignerSlot {
    const slot = this.bySession(sessionId);
    if (slot.state !== 'awaiting_confirmation')
      throw new ToolError(
        'DESIGNER_STATE_CONFLICT',
        'The subagent must complete its session first.',
      );
    slot.state = 'closed';
    slot.updatedAt = new Date().toISOString();
    return { ...slot };
  }

  abort(reservationId: string, reason: string): DesignerSlot {
    const slot = this.require(reservationId);
    if (!['reserved', 'active', 'awaiting_confirmation'].includes(slot.state))
      throw new ToolError('DESIGNER_STATE_CONFLICT', `Reservation is ${slot.state}.`);
    if (!reason.trim()) throw new ToolError('INVALID_DESIGNER_REASON', 'Provide a reason.');
    slot.reason = reason.trim();
    slot.state = 'aborted';
    slot.updatedAt = new Date().toISOString();
    return { ...slot };
  }

  assertActive(sessionId: string): void {
    const slot = [...this.slots.values()].find(
      (entry) => entry.sessionId === sessionId && entry.state === 'active',
    );
    if (!slot || slot.state !== 'active')
      throw new ToolError(
        'DESIGNER_SESSION_CLOSED',
        `Session ${sessionId} has no active designer slot.`,
      );
  }

  private require(reservationId: string): DesignerSlot {
    const slot = this.slots.get(reservationId);
    if (!slot)
      throw new ToolError('DESIGNER_RESERVATION_NOT_FOUND', 'Unknown designer reservation.');
    return slot;
  }

  private bySession(sessionId: string): DesignerSlot {
    const slot = [...this.slots.values()]
      .reverse()
      .find(
        (entry) => entry.sessionId === sessionId && !['closed', 'aborted'].includes(entry.state),
      );
    if (!slot) throw new ToolError('DESIGNER_SESSION_NOT_FOUND', 'Unknown designer session.');
    return slot;
  }
}
