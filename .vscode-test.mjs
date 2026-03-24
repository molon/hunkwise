import { defineConfig } from '@vscode/test-cli';
import path from 'path';

export default defineConfig({
  files: 'out-integration/test/integration/**/*.test.js',
  installPath: '/Applications/Visual Studio Code - Insiders.app',
  workspaceFolder: path.resolve('src/test/integration/workspace'),
  launchArgs: [
    '--enable-proposed-api=molon.hunkwise',
    '--disable-extensions',
    '--disable-gpu',
  ],
  mocha: {
    timeout: 30000,
  },
});
