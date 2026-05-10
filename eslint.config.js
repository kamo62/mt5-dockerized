import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/dist-types/**",
      "**/node_modules/**",
      "**/*.d.ts",
      "**/*.d.ts.map",
      "**/*.tsbuildinfo"
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["apps/web/src/**/*.ts", "apps/web/src/**/*.tsx"],
    languageOptions: {
      globals: {
        clearInterval: "readonly",
        document: "readonly",
        fetch: "readonly",
        HTMLIFrameElement: "readonly",
        localStorage: "readonly",
        setInterval: "readonly",
        window: "readonly",
      },
    },
  },
);
