// Host ↔ container path translation.
//
// Inside Docker the folder files are sent from is mounted at a fixed path (/files) and so is the
// downloads folder (/downloads), while Claude and the user keep talking in host paths:
// /Users/me/Documents/a.pdf on a Mac, C:\Users\me\Documents\a.pdf on Windows. These functions map
// one to the other. They use the posix and win32 flavours of node:path explicitly, so the result
// never depends on the operating system the server itself runs on.
import { posix, win32 } from 'node:path';

/** A drive-letter path (C:\… or C:/…) or a UNC path (\\server\share). */
export const isWindowsPath = (p: string): boolean => /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\]+\\/.test(p);

/** Trailing separators removed, except for a bare root such as "/" or "C:\". */
function trimRoot(root: string): string {
  const flavour = isWindowsPath(root) ? win32 : posix;
  const n = flavour.normalize(root);
  const parsed = flavour.parse(n);
  return n === parsed.root ? n : n.replace(/[\\/]+$/, '');
}

/**
 * Maps a host path under `hostRoot` to the same file under `mount`, with posix separators.
 * Returns undefined when the path is not under the root (prefix match on whole segments only,
 * case-insensitive for Windows roots). With `hostRoot === mount` it is an identity on the path.
 */
export function hostToContainer(hostPath: string, hostRoot: string, mount: string): string | undefined {
  const windows = isWindowsPath(hostRoot);
  const flavour = windows ? win32 : posix;
  const root = trimRoot(hostRoot);
  const full = flavour.normalize(hostPath);
  const [a, b] = windows ? [full.toLowerCase(), root.toLowerCase()] : [full, root];
  const rootEndsWithSep = /[\\/]$/.test(root);
  let rest: string;
  if (a === b) rest = '';
  else if (a.startsWith(rootEndsWithSep ? b : b + flavour.sep)) rest = full.slice(root.length);
  else if (windows && a.startsWith(b + '/')) rest = full.slice(root.length);
  else return undefined;
  const parts = rest.split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0) return mount;
  return posix.join(mount, ...parts);
}

/**
 * Maps a container path under `mount` back to the host, in the host root's own separator style.
 * Paths outside the mount are returned unchanged.
 */
export function containerToHost(containerPath: string, mount: string, hostRoot: string): string {
  const m = mount === '/' ? '/' : mount.replace(/\/+$/, '');
  if (containerPath !== m && !containerPath.startsWith(m === '/' ? '/' : m + '/')) return containerPath;
  const parts = containerPath.slice(m.length).split('/').filter(Boolean);
  const root = trimRoot(hostRoot);
  if (parts.length === 0) return root;
  return isWindowsPath(root) ? win32.join(root, ...parts) : posix.join(root, ...parts);
}
