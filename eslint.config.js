import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'supabase/**',
      'data/**',
      'tailwind.config.js',
      'postcss.config.js',
    ],
  },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        // Node.js globals
        process: 'readonly',
        Buffer: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        performance: 'readonly',
        URL: 'readonly',
        // Web / Fetch standard globals
        fetch: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        Headers: 'readonly',
        AbortController: 'readonly',
        window: 'readonly',
        document: 'readonly',
        localStorage: 'readonly',
        navigator: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
);
