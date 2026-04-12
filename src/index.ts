#!/usr/bin/env node

import { Command } from 'commander';
import { loginCommand } from './commands/login.js';
import { releaseCommand } from './commands/release.js';
import { patchCommand } from './commands/patch.js';
import { previewCommand } from './commands/preview.js';
import { statusCommand } from './commands/status.js';

const program = new Command();

program
  .name('sankofa')
  .description('Sankofa Deploy — push OTA updates to your React Native apps')
  .version('0.1.0');

program.addCommand(loginCommand);
program.addCommand(releaseCommand);
program.addCommand(patchCommand);
program.addCommand(previewCommand);
program.addCommand(statusCommand);

program.parse();
