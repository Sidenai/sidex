import tseslint from 'typescript-eslint';

const localPlugin = {
  rules: {
    'code-no-any-casts': { meta: { docs: {} }, create() { return {}; } },
    'code-no-dangerous-type-assertions': { meta: { docs: {} }, create() { return {}; } },
    'code-no-potentially-unsafe-disposables': { meta: { docs: {} }, create() { return {}; } },
    'code-no-deep-import-of-internal': { meta: { docs: {} }, create() { return {}; } },
    'code-amd-node-module': { meta: { docs: {} }, create() { return {}; } },
    'code-must-use-super-dispose': { meta: { docs: {} }, create() { return {}; } },
  },
};

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'src-tauri/target/**', 'extensions/**', 'src/vscode-dts/**', 'src/typings/**', '**/test/**/fixtures/**'],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [tseslint.configs.recommended],
    plugins: { local: localPlugin },
    rules: {
      'curly': 'warn',
      'eqeqeq': 'warn',
      'prefer-const': ['warn', { destructuring: 'all' }],
      'no-caller': 'warn',
      'no-debugger': 'warn',
      'no-duplicate-imports': 'warn',
      'no-eval': 'warn',
      'no-new-wrappers': 'warn',
      'no-throw-literal': 'warn',
      'no-var': 'warn',
      'no-restricted-globals': ['warn', 'name', 'length', 'event', 'closed', 'status', 'origin'],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/naming-convention': 'off',
      'local/code-no-any-casts': 'off',
      'local/code-no-dangerous-type-assertions': 'off',
      'local/code-no-potentially-unsafe-disposables': 'off',
      'local/code-no-deep-import-of-internal': 'off',
      'local/code-amd-node-module': 'off',
      'local/code-must-use-super-dispose': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-namespace': 'off',
      '@typescript-eslint/no-this-alias': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      '@typescript-eslint/no-duplicate-enum-values': 'off',
      '@typescript-eslint/no-non-null-asserted-optional-chain': 'off',
      '@typescript-eslint/no-unsafe-declaration-merging': 'off',
      'prefer-rest-params': 'off',
      'prefer-spread': 'off',
      '@typescript-eslint/prefer-as-const': 'off',
    },
  },
  {
    files: ['**/*.cjs'],
    rules: {
      'curly': 'warn',
      'eqeqeq': 'warn',
      'no-caller': 'warn',
      'no-debugger': 'warn',
      'no-eval': 'warn',
      'no-var': 'warn',
    },
  },
);