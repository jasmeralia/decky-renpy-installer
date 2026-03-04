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
    format: "cjs",
    sourcemap: true,
    exports: "default",
  },
  // DO NOT add an `external` array — externalGlobals handles externalization
  // and import-to-global replacement in one step. Having both conflicts and
  // leaves `import` statements in the output.
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
    // Replaces import statements for Decky-provided globals with direct window
    // variable references, eliminating all `import` statements from the output.
    // Decky's plugin loader evaluates the bundle without a native ES module
    // context, so any `import` statement is a SyntaxError.
    //
    // @decky/manifest is a virtual module consumed by @decky/api; we inline
    // the manifest JSON directly so it doesn't remain as an import statement.
    externalGlobals({
      react: "SP_REACT",
      "react-dom": "SP_REACTDOM",
      "@decky/ui": "DFL",
      "@decky/manifest": `(${JSON.stringify(manifest)})`,
    }),
  ],
};
