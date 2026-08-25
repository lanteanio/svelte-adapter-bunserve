// Re-export of the build-generated WebSocket handler module from a
// runtime/-root module, so handler/* submodules can import it via
// ../ws-handler-bridge.js.
//
// The `#ws-handler` specifier is a package import, resolved by the NEAREST
// package.json in every world this module runs in: the build writes one into
// the output root mapping it to the generated handler chunk, and this repo's
// own package.json maps it - under the `bunserve-test` and `bunserve-sim`
// conditions - to the unit-test stub and the simulator hooks. One mechanism,
// resolved natively by Node and Bun alike; the loader-hook spelling it
// replaces was a silent no-op under Bun, which left every source-level suite
// unable to run there.
import * as wsModule from '#ws-handler';

export { wsModule };
