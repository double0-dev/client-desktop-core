import { rendererExtension } from '@renderer/lib/extension/registry';
import type { IntegrationsSlot } from '@renderer/lib/extension/types';

/**
 * The integrations slot's hooks (`RendererExtension.integrations`), or the
 * core build's answers: every repo offered, no repo folder.
 * Always the same object for a window's lifetime, so callers call its hooks
 * unconditionally.
 */
type IntegrationHooks = Pick<
  IntegrationsSlot,
  'useRepoOffered' | 'useProjectRepoFolder' | 'useRepoFolders'
>;

const offerEvery = (): boolean => true;
const NO_FOLDERS: readonly string[] = [];

const NO_INTEGRATIONS: IntegrationHooks = {
  useRepoOffered: () => offerEvery,
  useProjectRepoFolder: () => null,
  useRepoFolders: () => NO_FOLDERS,
};

/** Read at render time, never at module load (the extension installs before boot). */
export function integrationHooks(): IntegrationHooks {
  return rendererExtension().integrations ?? NO_INTEGRATIONS;
}
