import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

/**
 * Flat config for the Control Center (Vite + React + TypeScript).
 *
 * `npm run lint` existed in package.json with no eslint dependency and no
 * config, so it could only ever fail — the point of this file is that the
 * command CI would run is the command that works. `dist/` is committed here
 * (the dashboard is served from it), and linting built bundles reports errors
 * the source does not have, so it is ignored.
 */
export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      // The API responses this app renders are untyped JSON, so `any` is the
      // honest type at the boundary; the rule stays on elsewhere.
      "@typescript-eslint/no-explicit-any": "warn",
      // A leading underscore is this codebase's spelling of "deliberately
      // unused" (the password generator's `_char` match parameters), so the
      // rule honours it instead of the code having to drop the name.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);
