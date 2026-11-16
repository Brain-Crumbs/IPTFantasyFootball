import { fileURLToPath } from 'node:url';
import { createProjectServices, npmValidatorCommands } from '@brain-crumbs/vibez';
import { runCli } from '@brain-crumbs/vibez/cli';
import {
  GitHubCiStatusOperations,
  GitHubControlledMergePullRequestOperations,
  GitHubMergeReadinessPullRequestOperations,
  GitHubPullRequestOperations,
} from '@brain-crumbs/vibez/integration';

const repository = 'Brain-Crumbs/IPTFantasyFootball';
const [owner, repo] = repository.split('/');
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const localNtfs = args.includes('--local-ntfs');
if (localNtfs) args.splice(args.indexOf('--local-ntfs'), 1);
const [command, operation] = args.filter(argument => argument !== '--json');
const controller = new AbortController();
const interrupt = () => controller.abort();
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);

async function run() {
  if (!command || ['help', '--help', '-h', 'version', '--version', '-v'].includes(command)) {
    return runCli(args);
  }
  const token = process.env.IPT_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN;
  const mergeAuthorization = process.env.IPT_DRIVER_MERGE;
  const fetchImpl = (url, init) => {
    if (!token) throw new Error('Supply trusted GitHub credentials for PR and CI operations.');
    return fetch(url, { ...init, signal: AbortSignal.timeout(30_000), redirect: 'error' });
  };
  const github = { owner, repo, token: token || 'credentials-required', fetchImpl };
  const services = await createProjectServices({
    projectRoot,
    configPath: 'vibez.config.json',
    ...(localNtfs ? { verifyLocalStorage: () => true } : {}),
  }, {
    identity: 'ipt-fantasy-football-manual-npm@1',
    executors: npmValidatorCommands(process.env.npm_execpath),
    integration: {
      repository,
      publication: new GitHubPullRequestOperations({
        ...github,
        fetchImpl: (url, init) => {
          if (init.method !== 'POST' || !url.endsWith('/pulls')) return fetchImpl(url, init);
          return fetchImpl(url, { ...init, body: JSON.stringify({ ...JSON.parse(init.body), draft: true }) });
        },
      }),
      pullRequests: new GitHubMergeReadinessPullRequestOperations(github),
      ci: new GitHubCiStatusOperations(github),
      merge: new GitHubControlledMergePullRequestOperations(github),
    },
    authorizePublication: request => Boolean(token)
      && request.repository === repository
      && command === 'orchestrate'
      && ['publish', 'ready'].includes(operation),
    authorizeMerge: request => Boolean(token)
      && request.repository === repository
      && mergeAuthorization === `${repository}#${request.number}@${request.expectedHeadSha}`,
    authorizeRecovery: request => (process.env.IPT_RECOVERY_ADMIN_ACTORS ?? '').split(',').includes(request.actorId),
  });
  return services.cli(args, controller.signal, {
    progress: message => process.stderr.write(`${message}\n`),
    ...(token ? { token } : {}),
    ...(mergeAuthorization ? { mergeAuthorization } : {}),
  });
}

try {
  const result = await run();
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
} catch (error) {
  // Configuration failures can originate in a trusted adapter. Never print its
  // exception text, which could contain credentials or private workspace paths.
  const message = 'Vibez could not open this project. Check the installed pin, tracked config, local storage and npm environment.';
  if (args.includes('--json')) {
    process.stdout.write(JSON.stringify({
      schemaVersion: '1.0.0', ok: false, command, data: null,
      error: { code: 'PROJECT_CONFIGURATION_REQUIRED', message },
    }) + '\n');
  } else {
    process.stderr.write(message + '\n');
  }
  process.exitCode = 4;
} finally {
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
}
