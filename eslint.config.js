import js from "@eslint/js";
import tseslint from "typescript-eslint";

const focusedTestSelectors = [
  {
    selector: "CallExpression[callee.type='MemberExpression'][callee.object.name=/^(?:describe|it|test)$/][callee.property.name='only']",
    message: "Focused tests are not allowed in committed source.",
  },
  {
    selector: "CallExpression[callee.type='MemberExpression'][callee.object.name=/^(?:describe|it|test)$/][callee.property.name='skip']",
    message: "Skipped tests are not allowed in committed source.",
  },
];

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/.stryker-tmp/**",
      "**/.turbo/**",
      "fixtures/**",
      "**/*.tsbuildinfo",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        Buffer: "readonly",
        clearTimeout: "readonly",
        console: "readonly",
        fetch: "readonly",
        process: "readonly",
        setTimeout: "readonly",
        URL: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "no-restricted-syntax": ["error", ...focusedTestSelectors],
      "no-undef": "off",
    },
  },
);
