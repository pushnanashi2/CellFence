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
      "**/tmp/**",
      "**/.stryker-tmp/**",
      "**/.turbo/**",
      "fixtures/**",
      "**/*.tsbuildinfo",
      // M-5: tsc -b emits compiled .js next to each .ts in
      // packages/*/src/. Those .js files are build artifacts;
      // the .ts source is the linted source of truth.
      "packages/*/src/**/*.js",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs}"],
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
        structuredClone: "readonly",
        performance: "readonly",
        URL: "readonly",
      },
    },
    rules: {
      "no-restricted-syntax": ["error", ...focusedTestSelectors],
      "no-undef": "error",
    },
  },
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
      }],
      "no-restricted-syntax": ["error", ...focusedTestSelectors],
      "no-undef": "off",
    },
  },
  {
    files: ["cellfence-friction-study/**/*.{js,mjs,cjs,ts,tsx,mts,cts}"],
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
      "no-unused-vars": "off",
    },
  },
);
