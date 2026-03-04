import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import replace from "@rollup/plugin-replace";
import esbuild from "rollup-plugin-esbuild";

export default {
  input: "src/index.tsx",
  output: {
    file: "dist/index.js",
    format: "cjs",
    sourcemap: true,
  },
  external: [
    "react",
    "react-dom",
    "@decky/ui",
    "decky-frontend-lib",
    "@decky/api",
  ],
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
  ],
};
