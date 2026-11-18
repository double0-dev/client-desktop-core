import { describe, expect, it } from 'vitest';
import { forwardedServerList, localServerUrl, serverPort, serverPorts } from './server-urls';

describe('remote server URLs as this machine reaches them', () => {
  it('reads the host port, defaulting by scheme', () => {
    expect(serverPort('http://localhost:5173/')).toBe(5173);
    expect(serverPort('http://localhost/')).toBe(80);
    expect(serverPort('https://127.0.0.1/app')).toBe(443);
    expect(serverPort('ftp://localhost:21')).toBeNull();
    expect(serverPort('not a url')).toBeNull();
  });

  it('lists each port once, in order', () => {
    expect(
      serverPorts(['http://localhost:5173', 'http://127.0.0.1:5173/x', 'http://localhost:6006']),
    ).toEqual([5173, 6006]);
  });

  it('moves the origin to the local port and keeps path, query and hash', () => {
    expect(localServerUrl('http://localhost:5173/app/?a=1#top', 41234)).toBe(
      'http://127.0.0.1:41234/app/?a=1#top',
    );
    expect(localServerUrl('http://[::1]:3000', 41234)).toBe('http://127.0.0.1:41234');
    expect(localServerUrl('https://localhost', 41234)).toBe('https://127.0.0.1:41234');
  });

  it('announces an opened server as its local URL and any other as printed, with where it runs', () => {
    const local = new Map([[5173, 41234]]);
    expect(
      forwardedServerList(
        ['http://localhost:5173/', 'http://localhost:6006'],
        'build-box',
        (p) => local.get(p) ?? null,
        (p) => (p === 6006 ? 52000 : null),
      ),
    ).toEqual({
      urls: ['http://127.0.0.1:41234', 'http://localhost:6006'],
      forwarded: [
        {
          url: 'http://127.0.0.1:41234',
          hostId: 'build-box',
          port: 5173,
          remote: 'localhost:5173',
          open: true,
          remembered: null,
        },
        {
          url: 'http://localhost:6006',
          hostId: 'build-box',
          port: 6006,
          remote: 'localhost:6006',
          open: false,
          remembered: 52000,
        },
      ],
    });
  });

  it('folds two spellings of one opened server into one entry', () => {
    const list = forwardedServerList(
      ['http://localhost:5173', 'http://127.0.0.1:5173'],
      'build-box',
      () => 41234,
    );
    expect(list.urls).toEqual(['http://127.0.0.1:41234']);
  });
});
