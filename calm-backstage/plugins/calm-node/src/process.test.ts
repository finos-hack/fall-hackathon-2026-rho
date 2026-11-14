import os from 'node:os';
import { CalmCliError, runCalm } from './cli';
import {
  kubectlArgs,
  kubectlCommand,
  minikubeArgs,
  readKubernetesDeploySettings,
  requireKubernetesDeploy,
} from './kubernetes';
import { ProcessError, runProcess } from './process';

const logger = () => {
  const lines: string[] = [];
  return { lines, info: (l: string) => lines.push(l) } as any;
};
const cwd = os.tmpdir();

describe('runProcess', () => {
  it('logs each line of stdout and stderr and returns stdout', async () => {
    const log = logger();
    const { stdout } = await runProcess(
      process.execPath,
      [
        '-e',
        'console.log("one\\ntwo"); console.error("\\u001b[31mthree\\u001b[0m")',
      ],
      { cwd, logger: log },
    );
    expect(stdout).toBe('one\ntwo\n');
    expect([...log.lines].sort()).toEqual(['one', 'three', 'two']);
  });

  it('keeps quiet stdout out of the log but returns it', async () => {
    const log = logger();
    const { stdout } = await runProcess(
      process.execPath,
      ['-e', 'console.log(JSON.stringify({ a: 1 })); console.error("warn")'],
      { cwd, logger: log, quietStdout: true },
    );
    expect(JSON.parse(stdout)).toEqual({ a: 1 });
    expect(log.lines).toEqual(['warn']);
  });

  it('passes extra environment variables on top of the backend environment', async () => {
    const { stdout } = await runProcess(
      process.execPath,
      ['-e', 'console.log(process.env.CALM_TEST_VALUE, !!process.env.PATH)'],
      { cwd, logger: logger(), env: { CALM_TEST_VALUE: 'x' } },
    );
    expect(stdout.trim()).toBe('x true');
  });

  it('rejects with the exit code and the last lines of output', async () => {
    const run = runProcess(
      process.execPath,
      ['-e', 'console.error("it broke"); process.exit(3)'],
      { cwd, logger: logger() },
    );
    await expect(run).rejects.toBeInstanceOf(ProcessError);
    await expect(run).rejects.toMatchObject({
      exitCode: 3,
      tail: ['it broke'],
    });
  });

  it('says so when the program is not on the PATH', async () => {
    await expect(
      runProcess('calm-no-such-program', [], { cwd, logger: logger() }),
    ).rejects.toThrow(/calm-no-such-program was not found/);
  });
});

describe('runCalm', () => {
  it('still rejects with a CalmCliError', async () => {
    await expect(
      runCalm(['no-such-command'], { cwd, logger: logger() }),
    ).rejects.toBeInstanceOf(CalmCliError);
  });
});

describe('Kubernetes settings', () => {
  const config = (kubernetes?: object) =>
    ({
      getOptionalConfig: (key: string) => {
        expect(key).toBe('calm.deploy.kubernetes');
        return kubernetes
          ? {
              getOptionalString: (k: string) =>
                (kubernetes as Record<string, string>)[k],
            }
          : undefined;
      },
    } as any);
  const settings = {
    kubeconfig: '/repo/.kube/config',
    context: 'calm-backstage',
    minikubeProfile: 'calm-backstage',
    namespacePrefix: 'calm-',
  };

  it('reads calm.deploy.kubernetes, with defaults for the profile and the prefix', () => {
    expect(
      readKubernetesDeploySettings(
        config({ kubeconfig: '/repo/.kube/config', context: 'calm-backstage' }),
      ),
    ).toEqual(settings);
  });

  it('gives nothing without a kubeconfig or a context: there is no default cluster', () => {
    expect(readKubernetesDeploySettings(config())).toBeUndefined();
    expect(
      readKubernetesDeploySettings(config({ context: 'calm-backstage' })),
    ).toBeUndefined();
    expect(
      readKubernetesDeploySettings(
        config({ kubeconfig: '/repo/.kube/config' }),
      ),
    ).toBeUndefined();
  });

  it('refuses unset settings and a missing kubeconfig file, naming yarn k8s:up', async () => {
    await expect(requireKubernetesDeploy(undefined)).rejects.toThrow(
      /calm\.deploy\.kubernetes\.kubeconfig and \.context are not set.*yarn k8s:up/,
    );
    await expect(
      requireKubernetesDeploy({
        ...settings,
        kubeconfig: '/no/such/folder/.kube/config',
      }),
    ).rejects.toThrow(
      /The kubeconfig \/no\/such\/folder\/\.kube\/config .* does not exist\. Run `yarn k8s:up`/,
    );
  });

  it('always names the kubeconfig and context, or the profile', () => {
    expect(kubectlArgs(settings, ['get', 'pods'])).toEqual([
      '--kubeconfig',
      '/repo/.kube/config',
      '--context',
      'calm-backstage',
      'get',
      'pods',
    ]);
    expect(minikubeArgs(settings, ['image', 'ls'])).toEqual([
      '-p',
      'calm-backstage',
      'image',
      'ls',
    ]);
    expect(kubectlCommand(settings, ['-n', 'calm-x'])).toBe(
      'kubectl --kubeconfig /repo/.kube/config --context calm-backstage -n calm-x',
    );
  });
});
