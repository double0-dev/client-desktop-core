/**
 * Product copy that names the user's computer or its file manager. The app
 * ships for macOS, Windows and Linux, so these words follow the running OS
 * instead of being written for one of them.
 */
type Platform = 'mac' | 'windows' | 'linux';

function platformOf(userAgent: string): Platform {
  if (userAgent.includes('Mac')) return 'mac';
  if (userAgent.includes('Windows')) return 'windows';
  return 'linux';
}

/** "this Mac" / "this PC" / "this computer" - where local keys and tokens live. */
export function thisComputerLabel(userAgent: string): string {
  switch (platformOf(userAgent)) {
    case 'mac':
      return 'this Mac';
    case 'windows':
      return 'this PC';
    default:
      return 'this computer';
  }
}

/** The button that opens the OS file manager on a downloaded file. */
export function showInFileManagerLabel(userAgent: string): string {
  switch (platformOf(userAgent)) {
    case 'mac':
      return 'Show in Finder';
    case 'windows':
      return 'Show in File Explorer';
    default:
      return 'Show in folder';
  }
}

const USER_AGENT = typeof navigator !== 'undefined' ? navigator.userAgent : '';

export const THIS_COMPUTER = thisComputerLabel(USER_AGENT);
export const SHOW_IN_FILE_MANAGER_LABEL = showInFileManagerLabel(USER_AGENT);
