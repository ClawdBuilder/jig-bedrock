// The provider's extension entry, the second of the two in package.json's `pi.extensions`. It sits at bedrock/ so Pi loads the
// folder as its own extension, and the rest of the provider stays under bedrock/ with it. The code is in src/.
export { default } from "./src/index.ts";
