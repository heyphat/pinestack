import { expect, test } from 'bun:test';
import {
  checksumFor,
  compareVersions,
  tagFromLatestLocation,
  upgradeAssetName,
} from '../src/upgrade.js';

test('upgradeAssetName maps supported platforms onto release asset names', () => {
  expect(upgradeAssetName('darwin', 'arm64')).toBe('pinerun-darwin-arm64');
  expect(upgradeAssetName('darwin', 'x64')).toBe('pinerun-darwin-x64');
  expect(upgradeAssetName('linux', 'x64')).toBe('pinerun-linux-x64');
  expect(upgradeAssetName('linux', 'arm64')).toBe('pinerun-linux-arm64');
  expect(upgradeAssetName('win32', 'x64')).toBe('pinerun-windows-x64.exe');
});

test('upgradeAssetName is null for platforms without a prebuilt', () => {
  expect(upgradeAssetName('win32', 'arm64')).toBeNull(); // only windows-x64 ships
  expect(upgradeAssetName('freebsd', 'x64')).toBeNull();
  expect(upgradeAssetName('linux', 'ia32')).toBeNull();
});

test('compareVersions: numeric semver, v-prefix tolerated', () => {
  expect(compareVersions('0.1.0', '0.1.0')).toBe(0);
  expect(compareVersions('v0.1.0', '0.1.0')).toBe(0);
  expect(compareVersions('0.2.0', '0.1.9')).toBe(1);
  expect(compareVersions('0.1.9', '0.2.0')).toBe(-1);
  expect(compareVersions('0.10.0', '0.9.0')).toBe(1); // numeric, not lexicographic
  expect(compareVersions('1.0.0', '0.99.99')).toBe(1);
  expect(compareVersions('0.1', '0.1.0')).toBe(0); // missing fields are zero
  expect(compareVersions('0.1.1', '0.1')).toBe(1);
});

test('tagFromLatestLocation extracts the tag from the releases/latest redirect', () => {
  expect(tagFromLatestLocation('https://github.com/heyphat/pinestack/releases/tag/v0.1.0')).toBe(
    'v0.1.0',
  );
  expect(tagFromLatestLocation('/heyphat/pinestack/releases/tag/v1.2.3?foo=1')).toBe('v1.2.3');
  expect(tagFromLatestLocation('https://github.com/heyphat/pinestack/releases')).toBeNull();
});

test('checksumFor finds the asset line in sha256sum output', () => {
  const a = 'a'.repeat(64);
  const b = 'b'.repeat(64);
  const sums = `${a}  pinerun-linux-x64\n${b}  pinerun-darwin-arm64\n`;
  expect(checksumFor(sums, 'pinerun-darwin-arm64')).toBe(b);
  expect(checksumFor(sums, 'pinerun-linux-x64')).toBe(a);
  expect(checksumFor(sums, 'pinerun-windows-x64.exe')).toBeNull();
});

test('checksumFor tolerates binary-mode markers and does not prefix-match', () => {
  const a = 'a'.repeat(64);
  const sums = `${a} *pinerun-linux-x64\n`;
  expect(checksumFor(sums, 'pinerun-linux-x64')).toBe(a);
  // "pinerun-linux" must not match the "pinerun-linux-x64" line
  expect(checksumFor(sums, 'pinerun-linux')).toBeNull();
});
