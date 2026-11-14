import { CalmHubError } from '@internal/backstage-plugin-calm-common';
import { readControls } from './provider';

const hub = 'http://localhost:8090';
const requirement = (control: string) => ({
  url: `${hub}/calm/domains/sec/controls/${control}/requirement/versions/1.0.0`,
  domain: 'sec',
  control,
  version: '1.0.0',
});

describe('readControls', () => {
  it('skips a control the Hub does not hold and keeps the rest', async () => {
    const client = {
      controlRequirement: jest.fn(async (_d: string, control: string) => {
        if (control === 'gone') {
          throw new CalmHubError(404, `${hub}/...`, 'Not Found');
        }
        return { name: control };
      }),
    };
    const logger = { warn: jest.fn() };

    const controls = await readControls(
      client,
      [requirement('kept'), requirement('gone'), requirement('also-kept')],
      logger,
    );

    expect(controls.map(c => c.control)).toEqual(['kept', 'also-kept']);
    expect(controls[0].doc).toEqual({ name: 'kept' });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain('sec/gone 1.0.0 skipped');
  });

  it('still throws for other Hub failures, so the last good entities stay', async () => {
    const client = {
      controlRequirement: jest.fn(async () => {
        throw new CalmHubError(500, hub, 'Internal Server Error');
      }),
    };
    await expect(
      readControls(client, [requirement('any')], { warn: jest.fn() }),
    ).rejects.toThrow('Internal Server Error');
  });

  it('still throws when the Hub cannot be reached', async () => {
    const client = {
      controlRequirement: jest.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    };
    await expect(
      readControls(client, [requirement('any')], { warn: jest.fn() }),
    ).rejects.toThrow('fetch failed');
  });
});
