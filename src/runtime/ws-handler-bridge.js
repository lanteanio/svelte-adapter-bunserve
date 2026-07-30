// Re-export of the build-generated WebSocket handler module from a
// runtime/-root module, so handler/* submodules can import it via
// ../ws-handler-bridge.js.
//
// The build's replace map rewrites the import specifier below to a path
// relative to the OUTPUT ROOT. That path only resolves correctly from a file
// sitting at the root (this bridge), not from the deeper handler/ directory -
// which is the whole reason this indirection exists rather than importing the
// handler where it is used.
import * as wsModule from 'WS_HANDLER';

export { wsModule };
