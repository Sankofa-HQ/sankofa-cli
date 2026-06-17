import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import type { Stack, ProjectInfo } from './stack.js';

function findMainActivity(androidApp: string): string | null {
  const kotlinRoot = join(androidApp, 'src', 'main', 'kotlin');
  if (!existsSync(kotlinRoot)) return null;
  const stack: string[] = [kotlinRoot];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const s = statSync(full);
      if (s.isDirectory()) stack.push(full);
      else if (entry === 'MainActivity.kt') return full;
    }
  }
  return null;
}

export type ProductId = 'deploy' | 'switch' | 'config' | 'catch';

export interface ProductInfo {
  id: ProductId;
  name: string;
  flag: string;
  description: string;
  supportedStacks: Stack[];
}

export const PRODUCTS: Record<ProductId, ProductInfo> = {
  deploy: {
    id: 'deploy',
    name: 'Sankofa Deploy',
    flag: '--deploy',
    description: 'Over-the-air code updates for Flutter and React Native',
    supportedStacks: ['react-native', 'flutter'],
  },
  switch: {
    id: 'switch',
    name: 'Sankofa Switch',
    flag: '--flag',
    description: 'Feature flags',
    supportedStacks: ['react-native', 'flutter', 'web', 'native-ios', 'native-android'],
  },
  config: {
    id: 'config',
    name: 'Sankofa Config',
    flag: '--config',
    description: 'Remote configuration values',
    supportedStacks: ['react-native', 'flutter', 'web', 'native-ios', 'native-android'],
  },
  catch: {
    id: 'catch',
    name: 'Sankofa Catch',
    flag: '--catch',
    description: 'Error tracking + analytics',
    supportedStacks: ['react-native', 'flutter', 'web', 'native-ios', 'native-android'],
  },
};

export const ALL_PRODUCT_IDS: ProductId[] = ['deploy', 'switch', 'config', 'catch'];

export interface ProductOptions {
  deploy?: boolean;
  switch?: boolean;
  config?: boolean;
  catch?: boolean;
  all?: boolean;
}

export function selectedProducts(opts: ProductOptions): ProductId[] {
  if (opts.all) return [...ALL_PRODUCT_IDS];
  const picked: ProductId[] = [];
  if (opts.deploy) picked.push('deploy');
  if (opts.switch) picked.push('switch');
  if (opts.config) picked.push('config');
  if (opts.catch) picked.push('catch');
  return picked;
}

export function availableProductsForStack(stack: Stack): ProductInfo[] {
  return ALL_PRODUCT_IDS
    .map((id) => PRODUCTS[id])
    .filter((p) => p.supportedStacks.includes(stack));
}

export const SDK_PACKAGE_BY_STACK: Record<Stack, string | null> = {
  'react-native': 'sankofa-react-native',
  flutter: 'sankofa_flutter',
  web: '@sankofa/browser',
  'native-ios': 'sankofa_sdk_ios',
  'native-android': 'dev.sankofa.sdk:sankofa-android',
  unknown: null,
};

export interface InstalledProductReport {
  product: ProductId;
  installed: boolean;
  detail: string;
}

/**
 * Per-product, per-stack integration detection. For Deploy we have
 * reliable file signals (manifest + pubspec); for Switch / Config / Catch
 * the per-stack SDK is shared with Deploy so we cannot distinguish
 * "Switch is installed" from "Deploy SDK is in pubspec" at the file level.
 *
 * `explicitlyInstalled` (from `.sankofa.json` products list) is the ground
 * truth for those products: if the user ran `sankofa init --flag`, Switch
 * is installed. Without that signal we conservatively report "not
 * initialized" rather than guess from shared-SDK presence — accurate
 * beats generous when the cost of being wrong is a customer thinking
 * something is wired up when it isn't.
 */
export function detectInstalledProducts(
  project: ProjectInfo,
  explicitlyInstalled: ProductId[] = [],
): InstalledProductReport[] {
  return availableProductsForStack(project.stack).map((p) => ({
    product: p.id,
    ...detectProduct(p.id, project, explicitlyInstalled),
  }));
}

function detectProduct(
  productId: ProductId,
  project: ProjectInfo,
  explicitlyInstalled: ProductId[],
): { installed: boolean; detail: string } {
  // Deploy has reliable file signals on every stack.
  if (productId === 'deploy' && project.stack === 'flutter') {
    return detectDeployFlutter(project);
  }
  if (productId === 'deploy' && project.stack === 'react-native') {
    return detectDeployRN(project);
  }

  // Switch / Config / Catch: file-level detection is unreliable (shared
  // SDK package). Trust .sankofa.json's products list as the ground truth.
  if (explicitlyInstalled.includes(productId)) {
    const sdk = isSDKInstalled(project);
    return {
      installed: sdk.present,
      detail: sdk.present
        ? `${sdk.detail} (initialized via sankofa init)`
        : `marked installed in .sankofa.json but ${sdk.detail}`,
    };
  }
  return {
    installed: false,
    detail: `not initialized — run \`sankofa init ${PRODUCTS[productId].flag}\``,
  };
}

function detectDeployFlutter(project: ProjectInfo): { installed: boolean; detail: string } {
  const pubspec = readText(join(project.root, 'pubspec.yaml')) || '';
  // Accept both the unified package and the legacy Phase 7 package
  // so doctor remains accurate for projects mid-migration.
  const hasSdk = pubspec.includes('sankofa_flutter') || pubspec.includes('sankofa_deploy');

  // Per-platform native wiring. A Flutter project that only ships
  // Android isn't broken — same goes for iOS-only. We surface whichever
  // sides are present and whether each is wired correctly.
  const androidApp = join(project.root, 'android', 'app');
  const iosRunner = join(project.root, 'ios', 'Runner');
  const hasAndroid = readText(join(androidApp, 'src', 'main', 'AndroidManifest.xml')) !== null;
  const hasIos = readText(join(iosRunner, 'AppDelegate.swift')) !== null;

  // Android wiring lives in MainActivity.kt, not the manifest — current
  // `sankofa init` rewrites the activity to extend SankofaFlutterActivity.
  // (The legacy hook was `SankofaDeployApplication` in the manifest;
  // accept either so doctor doesn't flag old + new layouts.)
  const mainActivity = hasAndroid ? findMainActivity(androidApp) : null;
  const manifestText = hasAndroid
    ? readText(join(androidApp, 'src', 'main', 'AndroidManifest.xml')) || ''
    : '';
  const activityText = mainActivity ? readText(mainActivity) || '' : '';
  const androidWired = hasAndroid
    ? activityText.includes('SankofaFlutterActivity') ||
      manifestText.includes('SankofaDeployApplication')
    : null;
  const iosWired = hasIos
    ? (readText(join(iosRunner, 'AppDelegate.swift')) || '').includes('SankofaFlutterAppDelegate')
    : null;

  const wiredParts: string[] = [];
  if (androidWired === true) wiredParts.push('MainActivity');
  if (iosWired === true) wiredParts.push('AppDelegate');

  const unwiredParts: string[] = [];
  if (androidWired === false) unwiredParts.push('Android');
  if (iosWired === false) unwiredParts.push('iOS');

  if (hasSdk && unwiredParts.length === 0 && wiredParts.length > 0) {
    return { installed: true, detail: `pubspec + ${wiredParts.join(' + ')} wired` };
  }
  if (!hasSdk && (androidWired || iosWired)) {
    return {
      installed: false,
      detail: 'native wired but pubspec missing sankofa_flutter — run `flutter pub add sankofa_flutter`',
    };
  }
  if (hasSdk && unwiredParts.length > 0) {
    return {
      installed: false,
      detail: `pubspec OK but native not wired on ${unwiredParts.join(' + ')} — run \`sankofa init --deploy\``,
    };
  }
  return { installed: false, detail: 'not installed — run `sankofa init --deploy`' };
}

function detectDeployRN(project: ProjectInfo): { installed: boolean; detail: string } {
  const pkg = readJSON(join(project.root, 'package.json'));
  const deps = pkg ? { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) } : {};
  const hasSdk = !!deps['sankofa-react-native'];
  if (!hasSdk) {
    return { installed: false, detail: 'sankofa-react-native not in dependencies' };
  }
  // Bare RN: check MainApplication.kt for the bundle override.
  // Expo: check app.json plugins.
  const isExpo = !!deps['expo'];
  if (isExpo) {
    const appJson = readJSON(join(project.root, 'app.json'));
    const plugins: any[] = appJson?.expo?.plugins || [];
    const hasPlugin = plugins.some((p) => (typeof p === 'string' ? p : p?.[0]) === 'sankofa-react-native');
    return hasPlugin
      ? { installed: true, detail: `sankofa-react-native@${deps['sankofa-react-native']} + expo plugin` }
      : { installed: false, detail: 'SDK installed but app.json missing sankofa-react-native plugin' };
  }
  // Bare check is heuristic — we just trust that the SDK is enough since
  // detecting native patching for arbitrary MainApplication.kt locations
  // would be expensive.
  return { installed: true, detail: `sankofa-react-native@${deps['sankofa-react-native']}` };
}

function isSDKInstalled(project: ProjectInfo): { present: boolean; detail: string } {
  switch (project.stack) {
    case 'react-native': {
      const pkg = readJSON(join(project.root, 'package.json'));
      const deps = pkg ? { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) } : {};
      const version = deps['sankofa-react-native'];
      return version
        ? { present: true, detail: `sankofa-react-native@${version}` }
        : { present: false, detail: 'sankofa-react-native not in dependencies' };
    }
    case 'flutter': {
      const raw = readText(join(project.root, 'pubspec.yaml'));
      if (!raw) return { present: false, detail: 'pubspec.yaml missing' };
      if (raw.includes('sankofa_flutter')) {
        return { present: true, detail: 'sankofa_flutter in pubspec.yaml' };
      }
      if (raw.includes('sankofa_deploy')) {
        return { present: true, detail: 'sankofa_deploy in pubspec.yaml (legacy Phase 7; migrate to sankofa_flutter)' };
      }
      return { present: false, detail: 'sankofa_flutter not in pubspec.yaml' };
    }
    case 'web': {
      const pkg = readJSON(join(project.root, 'package.json'));
      const deps = pkg ? { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) } : {};
      const found = Object.keys(deps).find((k) => k.startsWith('@sankofa/') || k === 'sankofa-js');
      return found
        ? { present: true, detail: `${found}@${deps[found]}` }
        : { present: false, detail: 'no @sankofa/* package in dependencies' };
    }
    case 'native-ios': {
      const raw = readText(join(project.root, 'Package.swift'));
      if (!raw) return { present: false, detail: 'Package.swift missing' };
      return raw.includes('SankofaIOS') || raw.includes('sankofa_sdk_ios')
        ? { present: true, detail: 'SankofaIOS in Package.swift' }
        : { present: false, detail: 'SankofaIOS not in Package.swift' };
    }
    case 'native-android': {
      const gradle =
        readText(join(project.root, 'app', 'build.gradle.kts')) ||
        readText(join(project.root, 'app', 'build.gradle')) ||
        '';
      return gradle.includes('dev.sankofa.sdk') || gradle.includes('sankofa')
        ? { present: true, detail: 'dev.sankofa.sdk in build.gradle' }
        : { present: false, detail: 'dev.sankofa.sdk not in build.gradle' };
    }
    default:
      return { present: false, detail: 'unknown stack' };
  }
}

function readJSON(path: string): any | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function readText(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}
