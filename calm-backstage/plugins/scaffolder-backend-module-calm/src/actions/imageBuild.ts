import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import { publishedFolder } from './publishedFolder';
import { withServiceLock } from './serviceLock';
import { isDnsLabel } from '@internal/backstage-plugin-calm-common';
import {
  KubernetesDeploySettings,
  requireKubernetesDeploy,
  runMinikube,
} from '@internal/backstage-plugin-calm-node';

const IMAGE_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

/** `<name>:<tag>` for an image built into the cluster. Throws for a name or tag that would not work, and for `latest`. */
export function imageReference(name: string, tag: string): string {
  if (!isDnsLabel(name)) {
    throw new Error(
      `Image name ${JSON.stringify(
        name,
      )} must be lower-case letters, digits and hyphens, starting and ending with a letter or digit, at most 63 characters`,
    );
  }
  if (!IMAGE_TAG.test(tag)) {
    throw new Error(
      `Image tag ${JSON.stringify(
        tag,
      )} must be letters, digits, _ . or -, not starting with . or -, at most 128 characters`,
    );
  }
  if (tag === 'latest') {
    throw new Error(
      'Image tag latest is refused: Kubernetes would try to pull it, and a rerun would not roll out. Use a tag that is unique per run',
    );
  }
  return `${name}:${tag}`;
}

/**
 * `calm:image:build`: builds the published folder's Dockerfile into the image store of the local cluster
 * (`minikube -p <profile> image build`), so its pods can run the image without a registry.
 */
export function createCalmImageBuildAction(options: {
  /** `calm.deploy.kubernetes`; undefined when it is not configured. */
  settings?: KubernetesDeploySettings;
  /** Absolute path of `calm.publish.localDir`: only folders inside it are built. */
  localDir: string;
}) {
  return createTemplateAction({
    id: 'calm:image:build',
    description:
      'Builds the Dockerfile of a published service folder into the local cluster (minikube -p <calm.deploy.kubernetes.minikubeProfile> image build -t <name>:<tag> <dir>). Needs the cluster from `yarn k8s:up`.',
    schema: {
      input: {
        dir: z =>
          z
            .string()
            .describe(
              'The published folder (calm:publish:local output path), inside calm.publish.localDir; it holds the Dockerfile',
            ),
        name: z =>
          z
            .string()
            .describe('Image name: lower-case letters, digits and hyphens'),
        tag: z =>
          z
            .string()
            .describe(
              'Image tag, unique per run (e.g. the task id). latest is refused',
            ),
      },
      output: {
        image: z => z.string().describe('The image built, as <name>:<tag>'),
      },
    },
    async handler(outer) {
      await withServiceLock(
        outer,
        {
          dir: publishedFolder(options.localDir, outer.input.dir),
          acquire: false,
        },
        async ctx => {
          const settings = await requireKubernetesDeploy(options.settings);
          const image = imageReference(ctx.input.name, ctx.input.tag);
          const dir = publishedFolder(options.localDir, ctx.input.dir);
          ctx.logger.info(
            `KUBECONFIG=${settings.kubeconfig} minikube -p ${settings.minikubeProfile} image build -t ${image} ${dir}`,
          );
          await runMinikube(settings, ['image', 'build', '-t', image, dir], {
            cwd: dir,
            logger: ctx.logger,
            signal: ctx.signal,
          });
          ctx.logger.info(
            `Built ${image} into the minikube profile ${settings.minikubeProfile}`,
          );
          ctx.output('image', image);
        },
      );
    },
  });
}
