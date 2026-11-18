import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  installRendererExtension,
  resetRendererExtensionForTest,
} from '@renderer/lib/extension/registry';
import type { RailTool } from '@renderer/lib/extension/types';
import {
  getRailOrder,
  moveRailTab,
  sanitizeRailOrder,
  setRailOrder,
} from '@renderer/lib/rail-order';

// An extension's four rail tools (stand-ins), in the order it gives - the
// catalog the order is validated against includes them.
beforeAll(() =>
  installRendererExtension({
    edition: 'pro',
    railTools: ['gadget', 'widget', 'doohickey', 'gizmo'].map((id) => ({ id }) as RailTool),
    railOrder: ['gadget', 'projects', 'sessions', 'tabs', 'files', 'widget', 'doohickey', 'gizmo'],
  }),
);
afterAll(() => resetRendererExtensionForTest());

const DEFAULT_TOP = [
  'gadget',
  'projects',
  'sessions',
  'tabs',
  'files',
  'widget',
  'doohickey',
  'gizmo',
];

describe('sanitizeRailOrder', () => {
  it('defaults to every tool in the top cluster', () => {
    expect(sanitizeRailOrder(null)).toEqual({ top: DEFAULT_TOP, bottom: [] });
  });

  it('keeps the stored order and cluster split', () => {
    const order = sanitizeRailOrder({ top: ['widget', 'projects'], bottom: ['files'] });
    // Tools the stored order doesn't mention rejoin the end of the top cluster -
    // a tool added after the order was saved (gadget) included.
    expect(order).toEqual({
      top: ['widget', 'projects', 'gadget', 'sessions', 'tabs', 'doohickey', 'gizmo'],
      bottom: ['files'],
    });
  });

  it('drops unknown ids and duplicates (top cluster wins)', () => {
    const order = sanitizeRailOrder({
      top: ['projects', 'bogus', 'projects'],
      bottom: ['projects', 'files', 'files'],
    });
    expect(order.top).toEqual([
      'projects',
      'gadget',
      'sessions',
      'tabs',
      'widget',
      'doohickey',
      'gizmo',
    ]);
    expect(order.bottom).toEqual(['files']);
  });

  it('coerces a non-object document', () => {
    expect(sanitizeRailOrder('junk')).toEqual({ top: DEFAULT_TOP, bottom: [] });
  });
});

describe('moveRailTab', () => {
  beforeEach(() => setRailOrder({ top: DEFAULT_TOP, bottom: [] }));

  it('reorders within the top cluster', () => {
    moveRailTab('files', 'top', 'sessions');
    expect(getRailOrder().top).toEqual([
      'gadget',
      'projects',
      'files',
      'sessions',
      'tabs',
      'widget',
      'doohickey',
      'gizmo',
    ]);
  });

  it('moves a tool to the bottom cluster', () => {
    moveRailTab('widget', 'bottom', null);
    expect(getRailOrder()).toEqual({
      top: ['gadget', 'projects', 'sessions', 'tabs', 'files', 'doohickey', 'gizmo'],
      bottom: ['widget'],
    });
  });

  it('inserts before an item already in the bottom cluster', () => {
    moveRailTab('widget', 'bottom', null);
    moveRailTab('files', 'bottom', 'widget');
    expect(getRailOrder().bottom).toEqual(['files', 'widget']);
  });

  it('moves a tool back to the top cluster', () => {
    moveRailTab('widget', 'bottom', null);
    moveRailTab('widget', 'top', 'projects');
    expect(getRailOrder()).toEqual({
      top: ['gadget', 'widget', 'projects', 'sessions', 'tabs', 'files', 'doohickey', 'gizmo'],
      bottom: [],
    });
  });

  it('ignores a drop onto the tool itself', () => {
    moveRailTab('files', 'top', 'files');
    expect(getRailOrder().top).toEqual(DEFAULT_TOP);
  });
});
