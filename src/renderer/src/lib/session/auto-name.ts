import { agentSessionsCollection } from '@renderer/lib/collections';
import { LABEL_MAX } from '@renderer/lib/session/label';
import { conversationPtyId } from '@renderer/lib/workspace/layout';

const CONVERSATION_PREFIX = conversationPtyId('');

/**
 * The session whose conversation shell this PTY is, or null for every other
 * shell (extra tabs, `setup:`/`commands:` shells) - only the conversation
 * terminal speaks for the session's name.
 */
export function sessionIdOfConversationPty(ptyId: string): string | null {
  if (!ptyId.startsWith(CONVERSATION_PREFIX)) return null;
  const id = ptyId.slice(CONVERSATION_PREFIX.length);
  return id.length > 0 ? id : null;
}

/**
 * Normalize a raw OSC 0/2 title into a usable session label, or null when
 * nothing usable remains. Programs decorate titles - Claude Code prefixes its
 * activity glyph (`✳ Fixing auth tokens`), some shells emit control chars -
 * so: control chars out, leading decoration stripped down to the first
 * letter/digit, whitespace collapsed, capped at the label column's length.
 */
export function cleanTitle(raw: string): string | null {
  const cleaned = raw
    // eslint-disable-next-line no-control-regex -- stripping controls is the point
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, LABEL_MAX)
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Follow terminal title reports for auto-named sessions: while a session was
 * launched without a name (`autoNamed`), its label tracks whatever its
 * conversation terminal titles itself (OSC 0/2) - Claude Code's running task
 * summary, another CLI's title, a title-setting shell prompt. A manual rename
 * clears `autoNamed` (see workspace-chrome's saveSessionEdits) and the label
 * never moves again. Mounted once per window (see routes/_app/route.tsx);
 * whichever window owns the shell receives its titles, and the collection
 * update syncs to the rest. Returns an unsubscribe.
 */
export function observeAutoNaming(): () => void {
  const onTitleChange = window.api?.terminal?.onTitleChange;
  if (!onTitleChange) return () => {};
  return onTitleChange((ptyId, raw) => {
    const sessionId = sessionIdOfConversationPty(ptyId);
    if (!sessionId) return;
    const session = agentSessionsCollection.get(sessionId);
    if (!session?.autoNamed || session.status === 'archived') return;
    const title = cleanTitle(raw);
    if (!title || title === session.label) return;
    agentSessionsCollection.update(sessionId, (draft) => {
      draft.label = title;
    });
  });
}
