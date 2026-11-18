import { afterEach, describe, expect, it } from 'vitest';
import {
  installRendererExtension,
  resetRendererExtensionForTest,
} from '@renderer/lib/extension/registry';
import { orderSections, settingsSections, type SettingsSection } from './settings-sections';

const section = (id: string, label: string) =>
  ({ id, label, icon: () => null, description: '' }) as unknown as SettingsSection;

describe('orderSections', () => {
  it('keeps General first and sorts the rest by label', () => {
    const ordered = orderSections([
      section('terminal', 'Terminal'),
      section('browser', 'Browser'),
      section('general', 'General'),
      section('files', 'File explorer'),
      section('editor', 'Editor'),
    ]);
    expect(ordered.map((s) => s.label)).toEqual([
      'General',
      'Browser',
      'Editor',
      'File explorer',
      'Terminal',
    ]);
  });

  it('orders the shipped list the same way', () => {
    const sections = settingsSections();
    expect(sections[0].id).toBe('general');
    const rest = sections.slice(1).map((s) => s.label);
    expect(rest).toEqual([...rest].sort((a, b) => a.localeCompare(b)));
  });

  it('marks no core section as experimental (Hosts, the one that is, is Pro)', () => {
    expect(settingsSections().filter((s) => s.experimental)).toEqual([]);
  });
});

describe('settingsSections', () => {
  afterEach(() => resetRendererExtensionForTest());

  it('lists no Pro section in the core build', () => {
    // Tasks (M2), and Integrations + Changes (decision 17, M4): nothing in the
    // core build uses a connected account or shows a Changes diff.
    const ids = settingsSections().map((s) => s.id);
    for (const pro of ['tasks', 'integrations', 'changes', 'browser', 'hosts'] as const) {
      expect(ids).not.toContain(pro);
    }
  });

  it('puts a registered section in label order, General still first', () => {
    installRendererExtension({
      edition: 'pro',
      railTools: [],
      settingsSections: [{ ...section('tasks', 'Tasks'), Body: () => null } as never],
    });
    const ids = settingsSections().map((s) => s.id);
    expect(ids[0]).toBe('general');
    // Tasks sorts after Sessions and before Terminal.
    expect(ids.indexOf('tasks')).toBe(ids.indexOf('terminal') - 1);
  });
});
