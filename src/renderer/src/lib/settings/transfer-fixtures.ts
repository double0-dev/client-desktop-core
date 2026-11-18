import { vi } from 'vitest';
import { EXPORT_FORMAT, EXPORT_VERSION } from './settings-transfer';

/**
 * Test fixtures for Settings › export / import (a test helper - only test
 * files import it): core's settings-transfer.test.ts, and an extension's
 * tests of its own sections, run against the same fake bridges.
 */

/**
 * An in-memory stand-in for the main-process bridges the transfer touches: the
 * database, the layout store and the integrations preference store. `extraApi`
 * adds a bridge an extension's sections use (an image store).
 */
export function fakeDb(
  seed: Record<string, Record<string, unknown>[]> = {},
  extraApi: Record<string, unknown> = {},
) {
  const tables: Record<string, Record<string, unknown>[]> = {
    projects: [],
    agent_sessions: [],
    ...JSON.parse(JSON.stringify(seed)),
  };
  const layouts: { sessionId: string; layout: unknown }[] = [];
  const api = {
    ...extraApi,
    integrations: {
      getAll: vi.fn(async () => ({ states: null })),
      onChanged: vi.fn(() => () => {}),
      applySettings: vi.fn(async () => ({ state: {} })),
    },
    db: {
      list: vi.fn(async (table: string) => tables[table] ?? []),
      insert: vi.fn(async (table: string, row: Record<string, unknown>) => {
        tables[table] ??= [];
        tables[table].push(row);
        return row;
      }),
      update: vi.fn(async (table: string, id: string, patch: Record<string, unknown>) => {
        const row = (tables[table] ?? []).find((r) => r.id === id);
        Object.assign(row ?? {}, patch);
        return row;
      }),
      delete: vi.fn(async () => null),
      onChange: vi.fn(() => () => {}),
    },
    layout: {
      list: vi.fn(async () => layouts),
      save: vi.fn(async (sessionId: string, layout: unknown) => {
        layouts.push({ sessionId, layout });
        return { ok: true };
      }),
    },
  };
  return { api, tables, layouts };
}

/** Put a fake's bridges on `window.api`. */
export function installFakeApi(fake: { api: unknown }): void {
  Object.defineProperty(window, 'api', { configurable: true, writable: true, value: fake.api });
}

export const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
export const SESSION_ID = '22222222-2222-4222-8222-222222222222';
export const OTHER_OWNER = '99999999-9999-4999-8999-999999999999';

export const exportedProject = (over: Record<string, unknown> = {}) => ({
  id: PROJECT_ID,
  name: 'production-pipeline',
  description: null,
  path: '/Users/emmaw/code/production-pipeline',
  color: '#6366f1',
  pinned: false,
  sortOrder: 0,
  ownerId: OTHER_OWNER,
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
  ...over,
});

export const exportedSession = (over: Record<string, unknown> = {}) => ({
  id: SESSION_ID,
  label: 'Fix flaky tests',
  detail: '',
  agent: 'claude',
  status: 'idle',
  sortOrder: 0,
  projectId: PROJECT_ID,
  ownerId: OTHER_OWNER,
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
  ...over,
});

export const envelope = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: '2026-08-06T10:00:00.000Z',
    ...over,
  });
