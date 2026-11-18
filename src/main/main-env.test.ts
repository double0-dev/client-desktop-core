import { describe, expect, it } from 'vitest';
// The build-time env plumbing for the main bundle (scripts/main-env.mjs): a
// packaged app has no .env and no VITE_* in its environment, so anything not
// inlined here falls back to localhost in production - silently.
import {
  MAIN_ENV_KEYS,
  checkMainBundle,
  expectedApiHost,
  mainEnvDefines,
} from '../../scripts/main-env.mjs';

describe('mainEnvDefines', () => {
  it("turns core's VITE_* keys main reads into process.env defines with JSON literals", () => {
    const defines = mainEnvDefines({
      VITE_API_URL: ' https://api.example.test ',
      VITE_DESKTOP_PROTOCOL: 'com.example.app',
      VITE_RELEASES_FEED_URL: 'not-for-main',
    });
    expect(defines).toEqual({
      'process.env.VITE_API_URL': '"https://api.example.test"',
      'process.env.VITE_DESKTOP_PROTOCOL': '"com.example.app"',
    });
    expect(Object.keys(defines)).toHaveLength(MAIN_ENV_KEYS.length);
  });

  // The official build adds its own keys (electron.vite.config.ts reads them
  // from pro/); the core build bakes only core's.
  it('takes the keys to bake from the caller', () => {
    const defines = mainEnvDefines({ VITE_EXTRA_URL: 'https://extra.example.test' }, [
      ...MAIN_ENV_KEYS,
      'VITE_EXTRA_URL',
    ]);
    expect(defines['process.env.VITE_EXTRA_URL']).toBe('"https://extra.example.test"');
    expect(mainEnvDefines({ VITE_EXTRA_URL: 'x' })).not.toHaveProperty(
      'process.env.VITE_EXTRA_URL',
    );
  });

  it('defines unset or blank keys as the literal undefined, so the localhost fallback applies and no process.env read survives', () => {
    const defines = mainEnvDefines({ VITE_API_URL: '' });
    expect(Object.keys(defines)).toHaveLength(MAIN_ENV_KEYS.length);
    expect(defines['process.env.VITE_API_URL']).toBe('undefined');
    expect(defines['process.env.VITE_DESKTOP_PROTOCOL']).toBe('undefined');
  });
});

describe('checkMainBundle', () => {
  it('reports every process.env.VITE_* read that survived bundling, once each', () => {
    const src = 'const a = process.env.VITE_API_URL ?? "x"; const b = process.env.VITE_API_URL;';
    expect(checkMainBundle(src)).toEqual([
      'main bundle still reads process.env.VITE_API_URL at runtime',
    ]);
  });
  it('reports a missing expected host and passes a clean bundle', () => {
    const src = 'const API_BASE_URL = "https://api.example.test";';
    expect(checkMainBundle(src, { expect: ['api.example.test'] })).toEqual([]);
    expect(checkMainBundle(src, { expect: ['api.other.example.test'] })).toEqual([
      'main bundle does not contain "api.other.example.test"',
    ]);
  });
});

describe('expectedApiHost', () => {
  it('is the host of VITE_API_URL, or null when unset or unparsable', () => {
    expect(expectedApiHost({ VITE_API_URL: 'https://api.example.test/' })).toBe('api.example.test');
    expect(expectedApiHost({ VITE_API_URL: 'http://localhost:3000' })).toBe('localhost:3000');
    expect(expectedApiHost({})).toBeNull();
    expect(expectedApiHost({ VITE_API_URL: 'nope' })).toBeNull();
  });
});
