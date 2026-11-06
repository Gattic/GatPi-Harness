"use strict";

const tseslint = require("typescript-eslint");

module.exports = tseslint.config(
  {
    ignores: ["**/node_modules/**", "**/dist/**", "**/build/**", "**/coverage/**", "**/.worktrees/**"],
  },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.js"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true }],
    },
  },
  {
    files: ["**/*.ts"],
    rules: {
      // The harness intentionally uses any at package boundaries where the Pi
      // SDK types are resolved at runtime, and dynamic require for local JS.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-empty": "off",
      "no-constant-condition": "off",
      "no-useless-escape": "off",
    },
  },
);
