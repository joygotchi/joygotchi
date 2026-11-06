// The gallery reads the chain from the browser, so prerendering would ship a
// snapshot of whatever pets existed at build time.
export const ssr = false;
export const prerender = false;
