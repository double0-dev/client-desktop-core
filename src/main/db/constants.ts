// Single local-user id. Mirrors the renderer's
// src/renderer/src/lib/local-user.ts LOCAL_OWNER - kept in sync by hand since the
// main and renderer processes don't share modules. Valid v4-shaped UUID so it
// satisfies the `ownerId` uuid column / `z.string().uuid()` schema.
export const LOCAL_OWNER = '00000000-0000-4000-8000-000000000000';
