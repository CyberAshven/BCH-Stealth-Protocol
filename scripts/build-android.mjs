import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

function run(command, args, cwd = process.cwd()) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (!existsSync('android')) {
  run('npx', ['cap', 'add', 'android']);
}

run('npx', ['cap', 'sync', 'android']);

if (process.platform === 'win32') {
  run('gradlew.bat', ['assembleRelease'], 'android');
} else {
  run('./gradlew', ['assembleRelease'], 'android');
}