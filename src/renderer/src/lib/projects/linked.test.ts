import { describe, expect, it } from 'vitest';
import { isListedProject, listedProjectId, localProjectFor, projectFamily } from './linked';

const LAPTOP = { id: 'acme', hostId: null, linkedProjectId: null };
const CLONE = { id: 'acme-box', hostId: 'build-box', linkedProjectId: 'acme' };
const PLAIN = { id: 'box-home', hostId: 'build-box', linkedProjectId: 'acme' };
const OWN = { id: 'box-tools', hostId: 'build-box', linkedProjectId: null };
const all = [LAPTOP, CLONE, PLAIN, OWN];

describe('host projects listed under a project of this machine', () => {
  it('lists a linked host project as the project it serves, every other as itself', () => {
    expect(listedProjectId(CLONE, all)).toBe('acme');
    expect(listedProjectId(LAPTOP, all)).toBe('acme');
    expect(listedProjectId(OWN, all)).toBe('box-tools');
    expect(listedProjectId(null, all)).toBeNull();
    expect(all.filter((p) => isListedProject(p, all)).map((p) => p.id)).toEqual([
      'acme',
      'box-tools',
    ]);
  });

  it("gathers a project's sessions from its linked host projects", () => {
    expect([...projectFamily('acme', all)].sort()).toEqual(['acme', 'acme-box', 'box-home']);
    expect([...projectFamily('box-tools', all)]).toEqual(['box-tools']);
    expect(projectFamily(null, all).size).toBe(0);
  });

  it('shows a host project again when the project it served is gone - its sessions never vanish', () => {
    const orphaned = [CLONE, OWN];
    expect(listedProjectId(CLONE, orphaned)).toBe('acme-box');
    expect(isListedProject(CLONE, orphaned)).toBe(true);
  });

  it('never nests under another host project or itself', () => {
    const chained = { id: 'x', hostId: 'build-box', linkedProjectId: 'box-tools' };
    const selfish = { id: 'y', hostId: 'build-box', linkedProjectId: 'y' };
    const list = [...all, chained, selfish];
    expect(listedProjectId(chained, list)).toBe('x');
    expect(listedProjectId(selfish, list)).toBe('y');
  });

  it('links a session moved on from a host to the local project its chain started from', () => {
    expect(localProjectFor('acme', all)).toBe('acme');
    expect(localProjectFor('acme-box', all)).toBe('acme');
    // A host project of its own: no local project to list it under.
    expect(localProjectFor('box-tools', all)).toBeNull();
    expect(localProjectFor(null, all)).toBeNull();
    expect(localProjectFor('gone', all)).toBeNull();
  });
});
