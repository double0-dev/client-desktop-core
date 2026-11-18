// Local-first single-user identity. Replaces the removed auth session: the app
// runs for one local user, so `ownerId` is a fixed constant rather than a real
// account id. LOCAL_OWNER is a valid v4-shaped UUID so it satisfies the `ownerId`
// `z.string().uuid()` schema on every collection.
export const LOCAL_OWNER = '00000000-0000-4000-8000-000000000000';

/** Stub user matching `WorkspaceUser` ({ id, email, name }) consumed by the UI. */
export const LOCAL_USER = {
  id: LOCAL_OWNER,
  email: 'local@double0.app',
  name: 'You',
} as const;
