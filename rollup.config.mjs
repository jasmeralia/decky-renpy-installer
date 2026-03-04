import { readFileSync } from "fs";
import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import replace from "@rollup/plugin-replace";
import esbuild from "rollup-plugin-esbuild";
import externalGlobals from "rollup-plugin-external-globals";

const manifest = JSON.parse(readFileSync("./plugin.json", "utf-8"));

export default {
  input: "src/index.tsx",
  output: {
    file: "dist/index.js",
    format: "es",
    sourcemap: true,
  },
  // DO NOT add an `external` array — externalGlobals handles externalization
  // and import-to-global replacement in one step. Having both conflicts and
  // leaves dangling import statements in the output.
  plugins: [
    replace({
      preventAssignment: true,
      values: {
        "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV || "production"),
      },
    }),
    resolve({ browser: true }),
    commonjs(),
    esbuild({
      target: "es2022",
      tsconfig: "tsconfig.json",
      loaders: { ".tsx": "tsx" },
    }),
    // Must come AFTER all transformer plugins (commonjs, esbuild).
    // Decky uses ESMODULE_V1 loading (import()) when package.json has
    // "type": "module", so the bundle must be ESM (export default).
    // externalGlobals replaces Decky-provided module imports with direct
    // references to the globals Decky exposes on the window.
    //
    // @decky/manifest is a virtual module consumed by @decky/api; we inline
    // the manifest JSON directly so it resolves at build time.
    externalGlobals({
      react: "SP_REACT",
      "react-dom": "SP_REACTDOM",
      "@decky/ui": "DFL",
      "@decky/manifest": `(${JSON.stringify(manifest)})`,
    }),
  ],
};
