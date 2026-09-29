// Names the page added to `window` (compared with a pristine about:blank iframe, so browser
// built-ins such as MediaKeySystemAccess or VTTCue are excluded) that match a pattern.
export async function pageGlobals(page, pattern) {
  return page.evaluate(
    ({ source, flags }) => {
      const re = new RegExp(source, flags);
      const frame = document.createElement('iframe');
      document.body.appendChild(frame);
      try {
        const native = new Set(Object.getOwnPropertyNames(frame.contentWindow));
        return Object.getOwnPropertyNames(window).filter((k) => !native.has(k) && re.test(k));
      } finally {
        frame.remove();
      }
    },
    { source: pattern.source, flags: pattern.flags },
  );
}
