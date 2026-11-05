import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "node_modules", "test-results", "playwright-report", "ui"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: { ...globals.browser, ...globals.node } } },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-restricted-syntax": [
        "error",
        { selector: "CallExpression[callee.name='eval']", message: "The CSP forbids eval." },
        { selector: "NewExpression[callee.name='Function']", message: "The CSP forbids new Function." },
        { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML'] > JSXExpressionContainer > :not(CallExpression[callee.name='sanitizedHtml'])", message: "Only sanitizedHtml() output may be set as HTML." },
      ],
    },
  },
);
