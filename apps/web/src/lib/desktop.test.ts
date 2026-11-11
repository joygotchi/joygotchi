import { describe, expect, it } from 'vitest';
import { DESKTOP_VERSION, DOWNLOADS, downloadUrl, guessPlatform } from './desktop';
import tauri from '../../../desktop/src-tauri/tauri.conf.json';

describe('desktop downloads', () => {
  it('links the version the app is built as', () => {
    // The installer names come from tauri.conf.json; a mismatch is a 404.
    expect(DESKTOP_VERSION).toBe(tauri.version);
  });

  it('points every platform at a file on the release', () => {
    for (const one of DOWNLOADS) {
      expect(downloadUrl(one)).toBe(
        `https://github.com/joygotchi/joygotchi/releases/download/desktop-v${DESKTOP_VERSION}/${one.file}`
      );
    }
  });

  it('guesses the platform from a user agent', () => {
    expect(guessPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('mac-arm');
    expect(guessPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows');
    expect(guessPlatform('Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux');
    expect(guessPlatform('Mozilla/5.0 (Linux; Android 14)')).toBeNull();
    expect(guessPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)')).toBeNull();
  });
});
