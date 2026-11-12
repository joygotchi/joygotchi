/**
 * Where the desktop installers are.
 *
 * `.github/workflows/release-desktop.yml` builds them on a `desktop-v*` tag and
 * attaches them to that GitHub release. The names are Tauri's, built from the
 * version in `apps/desktop/src-tauri/tauri.conf.json` — bump both together.
 */
export const DESKTOP_VERSION = '0.1.1';

const REPO = 'https://github.com/joygotchi/joygotchi';
export const RELEASE_TAG = `desktop-v${DESKTOP_VERSION}`;
export const RELEASE_PAGE = `${REPO}/releases/tag/${RELEASE_TAG}`;
export const ALL_RELEASES = `${REPO}/releases`;

export type Platform = 'mac-arm' | 'mac-intel' | 'windows' | 'linux';

export type Download = {
  platform: Platform;
  label: string;
  detail: string;
  file: string;
};

const asset = (file: string) => `${REPO}/releases/download/${RELEASE_TAG}/${file}`;

export const DOWNLOADS: Download[] = [
  {
    platform: 'mac-arm',
    label: 'macOS · Apple Silicon',
    detail: 'M1 and later',
    file: `JOYGOTCHI_${DESKTOP_VERSION}_aarch64.dmg`
  },
  {
    platform: 'mac-intel',
    label: 'macOS · Intel',
    detail: 'Older Macs',
    file: `JOYGOTCHI_${DESKTOP_VERSION}_x64.dmg`
  },
  {
    platform: 'windows',
    label: 'Windows',
    detail: '64-bit installer',
    file: `JOYGOTCHI_${DESKTOP_VERSION}_x64-setup.exe`
  },
  {
    platform: 'linux',
    label: 'Linux',
    detail: 'AppImage',
    file: `JOYGOTCHI_${DESKTOP_VERSION}_amd64.AppImage`
  }
];

export const downloadUrl = (download: Download) => asset(download.file);

/**
 * A best guess at the visitor's platform, from what the browser admits to.
 *
 * Apple Silicon and Intel Macs report the same user agent, so a Mac gets the
 * Apple Silicon build — every Mac sold since 2020 — and the Intel one is a
 * button beside it.
 */
export function guessPlatform(userAgent: string): Platform | null {
  const ua = userAgent.toLowerCase();
  if (ua.includes('windows')) return 'windows';
  if (ua.includes('mac os') || ua.includes('macintosh')) return 'mac-arm';
  if (ua.includes('android') || ua.includes('iphone') || ua.includes('ipad')) return null;
  if (ua.includes('linux')) return 'linux';
  return null;
}
