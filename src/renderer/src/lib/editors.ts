import { useEffect, useState } from 'react';
import { AppWindow, Braces, Code, Hammer, Smartphone, type LucideIcon } from 'lucide-react';

/** One IDE detected on this machine (mirrors src/main/editors.ts). */
export type InstalledEditor = { id: string; name: string };

/** Per-editor tile in the launcher menu: a rounded app-icon swatch + glyph. */
type EditorLook = { icon: LucideIcon; tile: string; fg: string };

const EDITOR_LOOK: Record<string, EditorLook> = {
  vscode: { icon: Code, tile: '#2C86EB', fg: '#ffffff' },
  xcode: { icon: Hammer, tile: '#0B5FBF', fg: '#ffffff' },
  'android-studio': { icon: Smartphone, tile: '#3DDC84', fg: '#0A0A0A' },
  intellij: { icon: Braces, tile: '#8B5CF6', fg: '#ffffff' },
};

/** Visuals for an editor id, with a neutral fallback for unknown ids. */
export function editorLook(id: string): EditorLook {
  return EDITOR_LOOK[id] ?? { icon: AppWindow, tile: '#3F3F46', fg: '#ffffff' };
}

// Detection shells out to subprocesses in main, so cache the first lookup for
// the window's lifetime - the list is effectively static within a session.
let cached: Promise<InstalledEditor[]> | null = null;
function loadEditors(): Promise<InstalledEditor[]> {
  if (!cached) {
    const api = window.api?.editors;
    cached = (api ? api.list() : Promise.resolve({ editors: [] }))
      .then((r) => r.editors ?? [])
      .catch(() => []);
  }
  return cached;
}

/** The IDEs installed on this machine (empty until loaded / off-macOS). */
export function useInstalledEditors(): InstalledEditor[] {
  const [editors, setEditors] = useState<InstalledEditor[]>([]);
  useEffect(() => {
    let alive = true;
    void loadEditors().then((list) => {
      if (alive) setEditors(list);
    });
    return () => {
      alive = false;
    };
  }, []);
  return editors;
}
