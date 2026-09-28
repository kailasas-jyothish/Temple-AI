// @ts-check
// Tiny structured logger. The repo convention (notifier/reels) is to always
// name the mode a stage ran in — aligned vs estimated, auto colour vs override —
// so a finished video can be explained after the fact. Keep every stage loud.

/** @param {string} stage @param {string} msg */
export function log(stage, msg) {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`${t} [${stage}] ${msg}`);
}

/** @param {string} stage @param {string} msg */
export function warn(stage, msg) {
  const t = new Date().toISOString().slice(11, 19);
  console.warn(`${t} [${stage}] WARN ${msg}`);
}
