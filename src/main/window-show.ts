/**
 * When a window created hidden (`show: false`) is put on screen.
 *
 * `ready-to-show` is NOT a once-per-window event: since Electron 45 every
 * webContents emits it at its first non-empty layout and repeats it on the
 * window that owns it - a `<webview>` guest too, at every page it loads
 * (`WebContents::OnFirstNonEmptyLayout`, read off the v45.3.1 source). And
 * `show()` is not "make visible": on macOS it activates the app over
 * whatever is in front (`activateIgnoringOtherApps:YES`) and makes the
 * window key. A handler left on with `on` took the user out of the app they
 * were working in each time a page loaded in a webview - or was first laid
 * out, which for a page loaded in a covered window is whenever something
 * next reads it (2026-11-13). So the window is shown at the first one only.
 */
export type ShowableWindow = {
  once(event: 'ready-to-show', listener: () => void): unknown;
  show(): void;
};

export function showWhenFirstReady(win: ShowableWindow, afterShow?: () => void): void {
  win.once('ready-to-show', () => {
    win.show();
    afterShow?.();
  });
}
