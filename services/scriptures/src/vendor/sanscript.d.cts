// Keeps tsc out of the vendored file: the library is checked upstream, not here.
declare const Sanscript: { t: (text: string, from: string, to: string, options?: object) => string };
export = Sanscript;
