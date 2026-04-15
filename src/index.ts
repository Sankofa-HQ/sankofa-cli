#!/usr/bin/env node

import { Command } from 'commander';
import { loginCommand } from './commands/login.js';
import { logoutCommand } from './commands/logout.js';
import { switchCommand } from './commands/switch.js';
import { releaseCommand } from './commands/release.js';
import { patchCommand } from './commands/patch.js';
import { previewCommand } from './commands/preview.js';
import { statusCommand } from './commands/status.js';
import { submitCommand } from './commands/submit.js';
import { distCommand } from './commands/dist.js';
import { doctorCommand } from './commands/doctor.js';
import { initCommand } from './commands/init.js';
import { releasesCommand, patchesCommand } from './commands/manage.js';
import { upgradeCommand } from './commands/upgrade.js';

const program = new Command();

program
  .name('sankofa')
  .description('Sankofa Deploy — push OTA updates to your React Native apps')
  .version('0.1.0');

program.addCommand(initCommand);
program.addCommand(doctorCommand);
program.addCommand(loginCommand);
program.addCommand(logoutCommand);
program.addCommand(switchCommand);
program.addCommand(releaseCommand);
program.addCommand(patchCommand);
program.addCommand(previewCommand);
program.addCommand(statusCommand);
program.addCommand(releasesCommand);
program.addCommand(patchesCommand);
program.addCommand(distCommand);
program.addCommand(submitCommand);
program.addCommand(upgradeCommand);

program.parse();
