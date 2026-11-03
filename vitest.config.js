import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['server/**/__tests__/**/*.test.js', 'src/**/*.{test,spec}.{ts,tsx}'],
    environment: 'node',
    globals: true,
  },
});
