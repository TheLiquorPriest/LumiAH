// How the bundles are made, where the build and the test that builds the runtime's code the same
// way (test/runtime/built.test.ts) both read it.

/**
 * Optional requires of packages this repository doesn't install, kept out of every bundle (each
 * stays a `require` of its name there, which fails where nothing beside the bundle provides it):
 * - `supports-color`: `debug`, which gaxios's https-proxy-agent and agent-base bring into the
 *   runtime under Google's SDK, requires it inside a try/catch that swallows its absence
 *   (`debug/src/node.js`: "it doesn't have to be"), only to pick more colours for debug's own
 *   lines, which print only when the DEBUG variable names them. Without it debug keeps its six
 *   basic colours; nothing else changes. (`has-flag` came only with it.)
 */
export const LEFT_OUT: readonly string[] = ["supports-color"];

/**
 * Flags of the runtime's bundle alone.
 * - `--ignore-dce-annotations`: a module that some other module loads with `import()` is started
 *   lazily by Bun's bundler, and for a package that declares its modules free of side effects the
 *   bundler then leaves that start out for whoever imports the same module the plain way. pi-ai
 *   is such a package and loads each provider's API lazily, so a function of pi-ai's called
 *   before any such API was used found its module's own state missing: ending an agent's session
 *   threw on a runtime that had not yet called an Anthropic model. With the annotations ignored,
 *   every module the bundle imports plainly is started as the bundle starts, which is how the
 *   sources run unbundled and so what every other test exercises. The bundle grows by about 30 KB.
 */
export const RUNTIME_FLAGS: readonly string[] = ["--ignore-dce-annotations"];
