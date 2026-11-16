import { fileURLToPath } from 'node:url';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { activeMigration, prepareAdmittedPublication, verifyConsumerAdmission } from './consumer-admission.mjs';
import { createProjectServices, describeCapabilities, npmValidatorCommands } from '@brain-crumbs/vibez';
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
const [command, operation, ...operands] = args.filter(argument => argument !== '--json');
const admittedSelection = `${activeMigration.taskId} --issue-number ${activeMigration.issueNumber}`;
const sessionOperations = new Set(['run', 'resume', 'rework', 'recover', 'recover-run', 'publish', 'ready']);
const controller = new AbortController();
const interrupt = () => controller.abort();
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);

function blocked(code, message) {
  const json = args.includes('--json');
  return {
    exitCode: 4,
    stdout: json ? JSON.stringify({
      schemaVersion: '1.0.0', ok: false, command, data: null, error: { code, message },
    }) + '\n' : '',
    stderr: json ? '' : message + '\n',
  };
}

async function requireEmptyIntake(paths) {
  for (const path of [paths.intake, paths.operations + '/driver/intakes']) {
    let entries;
    try {
      entries = await readdir(join(projectRoot, path));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (entries.length) throw new Error('Reviewed admission requires an empty issue intake.');
  }
}

async function run() {
  describeCapabilities({ apiVersion: '1.0.0', packageVersion: '0.1.0-rc.2' });
  if (!command || ['help', '--help', '-h', 'version', '--version', '-v'].includes(command)) {
    return runCli(args);
  }
  await verifyConsumerAdmission(projectRoot);
  if (command === 'orchestrate' && ['prepare', 'watch'].includes(operation)) {
    return blocked('REVIEWED_ADMISSION_REQUIRED', 'New tasks require reviewed admission. Use orchestrate select, run or resume for admitted tasks.');
  }
  if (command === 'orchestrate' && operation === 'select'
    && operands.join(' ') !== admittedSelection) {
    return blocked('ADMISSION_ISSUE_MISMATCH', `Select the reviewed task with orchestrate select ${admittedSelection}.`);
  }
  const token = process.env.IPT_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN;
  const mergeAuthorization = process.env.IPT_DRIVER_MERGE;
  const recoveryActors = (process.env.IPT_RECOVERY_ADMIN_ACTORS ?? '').split(',');
  // Validators and Git subprocesses inherit ordinary environment variables.
  // Keep host authority available only to the explicit adapters.
  for (const name of ['IPT_GITHUB_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN', 'IPT_DRIVER_MERGE', 'IPT_RECOVERY_ADMIN_ACTORS']) {
    delete process.env[name];
  }
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
          if (!['POST', 'PATCH'].includes(init.method)) return fetchImpl(url, init);
          const payload = prepareAdmittedPublication(JSON.parse(init.body), init.method);
          return fetchImpl(url, { ...init, body: JSON.stringify(payload) });
        },
      }),
      pullRequests: new GitHubMergeReadinessPullRequestOperations(github),
      ci: new GitHubCiStatusOperations(github),
      merge: new GitHubControlledMergePullRequestOperations(github),
    },
    authorizePublication: request => Boolean(token)
      && request.repository === repository
      && request.taskId === activeMigration.taskId
      && command === 'orchestrate'
      && ['publish', 'ready'].includes(operation),
    authorizeMerge: request => Boolean(token)
      && request.repository === repository
      && mergeAuthorization === `${repository}#${request.number}@${request.expectedHeadSha}`,
    authorizeRecovery: request => recoveryActors.includes(request.actorId),
  });
  if (command === 'orchestrate' && sessionOperations.has(operation) && operands[0]) {
    const status = await services.cli(['--json', 'orchestrate', 'status', operands[0]], controller.signal);
    const session = JSON.parse(status.stdout).data;
    if (session?.taskId !== activeMigration.taskId || session?.issueNumber !== activeMigration.issueNumber) {
      return blocked('ADMISSION_SESSION_MISMATCH', 'Only the active reviewed migration session can write.');
    }
    if (['run', 'resume'].includes(operation)) {
      await requireEmptyIntake(services.config.document.paths);
    }
  }
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
  const message = error.code === 'UNSUPPORTED_STORAGE'
    ? 'Use a supported local checkout outside synchronized folders. On Windows, verify NTFS and pass --local-ntfs.'
    : 'Vibez could not open this project. Check the installed pin, tracked config, reviewed admission and npm environment.';
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
