import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import eslintConfigPrettier from 'eslint-config-prettier'

export default tseslint.config(
  { ignores: ['dist'] },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
      reactHooks.configs.flat['recommended-latest'],
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Matches the `_category` / `_` throwaway params already in the codebase
      // and lines up with tsconfig's noUnusedLocals / noUnusedParameters.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // react-hooks v7 ships the React Compiler rule set. This one flags the
      // codebase-wide `useEffect(() => { void load() }, [load])` fetch-on-mount
      // pattern, where setState only runs after an `await` (not synchronously).
      // Without a data-fetching layer that is the correct pattern here, so the
      // rule is off rather than error; revisit if a query library is adopted.
      'react-hooks/set-state-in-effect': 'off',
    },
  },
  // Node context for config files that aren't part of the app tsconfig.
  {
    files: ['*.config.{js,ts}'],
    languageOptions: { globals: globals.node },
    extends: [tseslint.configs.disableTypeChecked],
  },
  // Keep last: turn off every stylistic rule Prettier already owns.
  eslintConfigPrettier,
)
