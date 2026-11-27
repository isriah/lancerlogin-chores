// Point the plugin's SDK import at the stand-in. Import this statically first, then load plugin files that import the SDK
// with a dynamic import(): static imports are all resolved before any module body runs.
import { registerHooks } from "node:module";

const sdk = new URL("./module-sdk-stub.ts", import.meta.url).href;
registerHooks({ resolve: (specifier, context, next) => specifier === "@lancerlogin/module-sdk/api" ? { url: sdk, shortCircuit: true } : next(specifier, context) });
