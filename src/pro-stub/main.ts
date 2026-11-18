import type { MainExtension } from '../main/extension';

/** The core build's `@pro/main`: no Pro code, nothing registered, nothing entitled. */
export const proMain: MainExtension = {
  edition: 'core',
  entitled: () => false,
  register: () => ({}),
};
