/**
 * Non-interactive / headless detection utilities.
 *
 * Centralizes the various TTY, display server, and environment checks
 * so every subsystem agrees on whether we can prompt the user.
 *
 * Rule of thumb: if in doubt, assume non-interactive.
 * A false positive (thinking we're interactive when we're not) causes hangs.
 * A false negative (thinking we're not interactive when we are) causes a
 * graceful error message asking the user to set an env var. Much safer.
 */

/**
 * Returns true if a graphical display server is available.
 * On Linux, this means DISPLAY or WAYLAND_DISPLAY is set.
 * On macOS/Windows, we assume a display is always available
 * (the OS keychain uses its own prompting mechanism).
 */
export function hasDisplayServer(): boolean {
  if (process.platform === 'darwin' || process.platform === 'win32') {
    return true;
  }
  return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

/**
 * Returns true if the current process can safely prompt the user
 * for interactive input (TTY questions, keychain unlock dialogs, etc).
 *
 * Checks:
 * 1. AX_NON_INTERACTIVE env var (explicit override — always wins)
 * 2. CI env var (GitHub Actions, Jenkins, etc.)
 * 3. stdin TTY check
 */
export function isInteractive(): boolean {
  if (process.env.AX_NON_INTERACTIVE === '1' || process.env.AX_NON_INTERACTIVE === 'true') {
    return false;
  }
  if (process.env.CI) {
    return false;
  }
  return !!process.stdin.isTTY;
}

/**
 * Returns true if the OS keychain is likely to work without hanging.
 *
 * On Linux, keytar uses libsecret/GNOME Keyring which may try to show
 * an unlock dialog via D-Bus. If there's no display server and no TTY,
 * this dialog has nowhere to go and the call hangs forever.
 *
 * On macOS, the Keychain Access framework can show a system prompt,
 * but macOS services (LaunchAgent) typically have access to the login
 * keychain without prompting. We still timeout as a safety net.
 */
export function isKeychainAvailable(): boolean {
  if (process.env.AX_NON_INTERACTIVE === '1' || process.env.AX_NON_INTERACTIVE === 'true') {
    return false;
  }
  if (process.platform === 'linux') {
    return hasDisplayServer() || !!process.stdin.isTTY;
  }
  return true;
}
