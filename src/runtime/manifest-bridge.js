// Re-export of the build-generated manifest module from a runtime/-root module,
// so handler/* sub-modules can import it via ../manifest-bridge.js.
import { manifest, prerendered, base } from '#manifest';

export { manifest, prerendered, base };
