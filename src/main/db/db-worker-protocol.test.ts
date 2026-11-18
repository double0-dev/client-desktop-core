import { MessageChannel } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { reviveError, serializeError, type SerializedError } from './db-worker-protocol';

/**
 * Errors cross the thread through the same structured clone a Worker uses,
 * which keeps only an Error's name, message and stack: PGlite's fields
 * (`code`, `constraint`, `detail`) - what callers branch on - must survive.
 */

const roundTrip = (value: SerializedError): Promise<SerializedError> =>
  new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel();
    port2.once('message', (msg: SerializedError) => {
      port1.close();
      port2.close();
      resolve(msg);
    });
    port1.postMessage(value);
  });

describe('serializeError / reviveError', () => {
  it('keeps a database error’s fields across a real message port', async () => {
    const err = Object.assign(new Error('insert or update violates foreign key constraint'), {
      name: 'DatabaseError',
      code: '23503',
      constraint: 'agent_sessions_projectId_projects_id_fk',
      severity: 'ERROR',
      position: 7,
    });
    const revived = reviveError(await roundTrip(serializeError(err)));
    expect(revived).toBeInstanceOf(Error);
    expect(revived.name).toBe('DatabaseError');
    expect(revived.message).toBe(err.message);
    expect(revived).toMatchObject({
      code: '23503',
      constraint: 'agent_sessions_projectId_projects_id_fk',
      severity: 'ERROR',
      position: 7,
    });
    expect(revived.stack).toBe(err.stack);
  });

  it('drops fields a message cannot carry as plain values, and survives a non-Error throw', () => {
    const err = Object.assign(new Error('boom'), {
      code: 'X1',
      detail: { nested: true },
      fn: () => 1,
    });
    expect(serializeError(err).props).toEqual({ code: 'X1' });
    expect(reviveError(serializeError('plain string'))).toMatchObject({ message: 'plain string' });
  });
});
