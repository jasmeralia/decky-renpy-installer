import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import replace from "@rollup/plugin-replace";
import esbuild from "rollup-plugin-esbuild";
import externalGlobals from "rollup-plugin-external-globals";

export default {
  input: "src/index.tsx",
  output: {
    file: "dist/index.js",
    format: "esm",
    sourcemap: true,
    exports: "default",
  },
  // Only react, react-dom, and @decky/ui are provided by Decky's runtime as globals.
  // Everything else (@decky/api, decky-frontend-lib, react-icons) is bundled.
  external: ["react", "react-dom", "@decky/ui"],
  plugins: [
    replace({
      preventAssignment: true,
      values: {
        "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV || "production"),
      },
    }),
    // Replace import statements for Decky-provided globals with direct window variable
    // references. This eliminates all top-level `import` statements from the output,
    // which is required because Decky's plugin loader evaluates the bundle without a
    // native ES module context.
    externalGlobals({
      react: "SP_REACT",
      "react/jsx-runtime": "SP_JSX",
      "react-dom": "SP_REACTDOM",
      "@decky/ui": "DFL",
    }),
    resolve({ browser: true }),
    commonjs(),
    esbuild({
      target: "es2022",
      tsconfig: "tsconfig.json",
      loaders: { ".tsx": "tsx" },
    }),
  ],
};
