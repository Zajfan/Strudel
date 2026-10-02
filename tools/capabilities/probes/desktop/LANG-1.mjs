// LANG-1 (desktop): the browser probe, run against the desktop app's WebKitGTK webview through the
// desktop harness (lib/desktop/harness.mjs), which provides the same page interface.
export { probe } from '../browser/LANG-1.mjs';
export const usesPage = true;
