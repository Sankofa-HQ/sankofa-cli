import type { Platform } from './bundler.js';

export function normalizePlatform(value: string): Platform {
  const platform = value.toLowerCase();
  if (platform !== 'ios' && platform !== 'android') {
    throw new Error('Platform must be "ios" or "android"');
  }
  return platform as Platform;
}

export function normalizeEnvironment(value: string | undefined): 'live' | 'test' {
  const env = (value || 'live').toLowerCase();
  if (env !== 'live' && env !== 'test') {
    throw new Error('Environment must be "live" or "test"');
  }
  return env;
}

export function parseRollout(value: string | number | undefined): number {
  const rollout = typeof value === 'number' ? value : parseInt(value || '100', 10);
  if (!Number.isFinite(rollout) || Number.isNaN(rollout) || rollout < 0 || rollout > 100) {
    throw new Error('Rollout must be a number between 0 and 100');
  }
  return rollout;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
