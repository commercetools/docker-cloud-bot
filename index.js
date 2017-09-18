const dockerCloudConfigFile = 'docker-cloud-config.yml';

const isValidRegex = value =>
  typeof value === 'string' &&
  value.charAt(0) === '/' &&
  value.charAt(value.length - 1) === '/';
const convertStringToRegex = value =>
  new RegExp(value.substring(1, value.length - 1));

/* Selectors */

// Always pick the first branch in the list.
// NOTE: not sure if it's necessary to handle multiple branches.
const selectBranchName = context => context.payload.branches[0].name;
const selectIsWhitelistBranch = (branchName, config) => {
  if (!config.branches) return true;

  // Check first if there are whitelisted branches
  if (config.branches.only) {
    const branchesWhitelist = config.branches.only;
    const isBranchWhitelisted = branchesWhitelist.some(branch => {
      if (isValidRegex(branch))
        return convertStringToRegex(branch).test(branchName);
      return branch === branchName;
    });
    return isBranchWhitelisted;
  }

  // Check if there is a list of branches to be ignored
  if (config.branches.ignore) {
    const branchesBlacklist = config.branches.ignore;
    const isBranchBlacklisted = branchesBlacklist.some(branch => {
      if (isValidRegex(branch))
        return convertStringToRegex(branch).test(branchName);
      return branch === branchName;
    });
    return !isBranchBlacklisted;
  }

  // Unknown branch option, simply ignore
  return true;
};
const selectIssuerKey = context => context.payload.context;
const selectIsWhitelistIssuer = (issuerKey, issuersWhitelist) =>
  issuersWhitelist.some(issuer => issuer === issuerKey);
const selectChangeState = context => context.payload.state;

/* Config helpers */

const selectTriggerStatus = config => config.trigger.status;
const selectTriggerIssuers = config => config.trigger.issuers;
const selectNotifyOnCreate = config => config.notify.onCreate;
const selectNotifyOnUpdate = config => config.notify.onUpdate;
const selectNotifyOnDelete = config => config.notify.onDelete;
const selectStack = config => config.stack;

const formatErrorMessage = error =>
  error instanceof Error
    ? `\`\`\`\n${error.stack || error.message}\n\`\`\``
    : `\`\`\`json\n${JSON.stringify(error, null, 2)}\n\`\`\``;

module.exports = robot => {
  const stackApi = require('./stack')(robot);

  // From the "status change" event unfortunately we don't get the PR number,
  // which is necessary for posting comments on the PR.
  // Therefore we need to search for the PR number based on e.g. branch name and
  // git commit SHA.
  const getPullRequestNumber = async (meta, context) => {
    const searchQuery = meta.gitSha
      ? `head:${meta.branchName} is:pr ${meta.gitSha}`
      : `head:${meta.branchName} is:pr`;
    const result = await context.github.search.issues({ q: searchQuery });
    if (result.data.items.length === 0) {
      robot.log.warn(
        `[${context.event}] Could not find any Pull Request matching the following search criteria: "${searchQuery}"`
      );
      return;
    }
    return result.data.items[0].number;
  };
  const addComment = async (meta, context) => {
    const gitSha = context.payload.sha;
    let prNumber = meta.prNumber;
    if (!prNumber) {
      prNumber = await getPullRequestNumber(
        {
          branchName: meta.branchName,
          gitSha,
        },
        context
      );
    }

    // If there is a PR number, post the comment to the PR.
    if (prNumber) {
      const params = context.issue({ body: meta.message, number: prNumber });
      return context.github.issues.createComment(params);
    }

    if (!gitSha) {
      robot.log.error(
        `[${context.event}] Cannot comment to commit because git SHA is not defined "${gitSha}"`
      );
      return Promise.resolve();
    }
    robot.log(
      `[${context.event}] Add a comment directly to the commit "${gitSha}"`
    );
    // If no PR is found (e.g. has not been created yet), post the comment
    // directly to the commit.
    const params = context.issue({
      body: meta.message,
      sha: gitSha,
    });
    return context.github.repos.createCommitComment(params);
  };

  // Listen for `status` change events.
  // This is used for triggering a stack deployment, which should be executed
  // only after the CI system finished running the build jobs.
  robot.on('status', async context => {
    // Skip if the issuer of the event is the bot itself.
    if (context.isBot) {
      robot.log(`[${context.event}] The issuer is the bot, skip`);
      return;
    }

    // Load the bot configuration from the remote repository (`.github/docker-cloud-config.yml`)
    // TODO: validate the config.
    const config = await context.config(dockerCloudConfigFile);
    robot.log(`[${context.event}] Docker cloud config`, JSON.stringify(config));

    const branchName = selectBranchName(context);
    // The CI system that triggered this event, e.g. `continuous-integration/travis-ci/pr`
    const issuer = selectIssuerKey(context);
    // Get the state of the status change.
    const state = selectChangeState(context);
    const expectedState = selectTriggerStatus(config);

    // Determine if this event will trigger a stack deployment:
    // - branch has to match the filters configuration or being whitelisted/blacklisted
    // - issuer has to match on of the given keys (different for travis, circleci, ...)
    // - state has to match the given configuration (e.g. success)
    const isWhitelistBranch = selectIsWhitelistBranch(branchName, config);
    robot.log(
      `[${context.event}] isWhitelistBranch (${branchName})`,
      isWhitelistBranch
    );
    const isWhitelistIssuer = selectIsWhitelistIssuer(
      issuer,
      selectTriggerIssuers(config)
    );
    robot.log(
      `[${context.event}] isWhitelistIssuer (${issuer})`,
      isWhitelistIssuer
    );
    const isExpectedState = state === expectedState;
    robot.log(`[${context.event}] isExpectedState (${state})`, isExpectedState);

    if (isWhitelistBranch && isWhitelistIssuer && isExpectedState) {
      try {
        // Get the existing docker cloud stack, matching the branch name.
        const existingStack = await stackApi.getStackByName(branchName);
        // If the stack exists, try to redeploy it.
        if (existingStack) {
          const stack = await stackApi.redeployStack(existingStack);
          robot.log(
            `[${context.event}] Stack "${branchName}" has been redeployed`
          );
          if (selectNotifyOnUpdate(config))
            return addComment(
              {
                message: `:rocket: Stack \`${branchName}\` has been redeployed!`,
                branchName,
              },
              context
            );
          robot.log(`[${context.event}] Skip notification on stack update`);
          return;
        }
        // If the stack does not exist yet, try to create a new one.
        const createdStack = await stackApi.createStack(branchName, {
          stack: selectStack(config),
        });
        robot.log(
          `[${context.event}] Stack \`${branchName}\` has been created`,
          branchName
        );

        if (selectNotifyOnCreate(config)) {
          const deployedServices = await stackApi.getStackServiceUrls(
            createdStack
          );
          return addComment(
            {
              message: `:tada: Your new stack \`${branchName}\` has been created!\n\n${stackApi.getStackUrlForWebApp(
                createdStack
              )}\n\n${Object.keys(deployedServices).map(
                name =>
                  `* ${name}${deployedServices[name].map(
                    url => `\n  * ${url}`
                  )}`
              )}`,
              branchName,
            },
            context
          );
        }
        robot.log(`[${context.event}] Skip notification on stack create`);
        return;
      } catch (error) {
        robot.log.error(
          `[${context.event}] Error while deploying stack "${branchName}"`,
          error.stack || error
        );
        const formattedError = formatErrorMessage(error);
        return addComment(
          {
            message: `:stop_sign: Something went wrong while deploying the stack \`${branchName}\`. Have a look at the error message below.\n\n${formattedError}`,
            branchName,
          },
          context
        );
      }
    } else {
      robot.log(
        `[${context.event}] This event does not match the rules for deploying the stack "${branchName}", will be skipped`
      );
    }
  });

  robot.on('pull_request.closed', async context => {
    // Skip if the issuer of the event is the bot itself.
    if (context.isBot) {
      robot.log(`[${context.event}] The issuer of the event is the bot, skip`);
      return;
    }
    const branchName = context.payload.pull_request.head.ref;

    try {
      // Get the existing docker cloud stack, matching the branch name.
      const existingStack = await stackApi.getStackByName(branchName);
      // If the stack exists, try to redeploy it.
      if (existingStack && existingStack.state.toLowerCase() !== 'terminated') {
        await stackApi.terminateStack(existingStack);
        robot.log(
          `[${context.event}] Stack "${branchName}" has been scheduled for termination`
        );

        // Load the bot configuration from the remote repository (`.github/docker-cloud-config.yml`)
        // TODO: validate the config.
        const config = await context.config(dockerCloudConfigFile);
        robot.log(
          `[${context.event}] Docker cloud config`,
          JSON.stringify(config)
        );

        if (selectNotifyOnDelete(config))
          return addComment(
            {
              message: `:skull: Stack \`${branchName}\` has been scheduled for termination!`,
              branchName: branchName,
            },
            context
          );
        robot.log(`[${context.event}] Skip notification on stack delete`);
        return;
      } else {
        robot.log(
          `[${context.event}] The stack "${branchName}" does not exist or has already been terminated.`
        );
      }
    } catch (error) {
      robot.log.error(
        `[${context.event}] Error while terminating stack "${branchName}"`,
        error.stack || error
      );
      const formattedError = formatErrorMessage(error);
      return addComment(
        {
          message: `:stop_sign: Something went wrong while terminating the stack \`${branchName}\`. Have a look at the error message below.\n\n${formattedError}`,
          branchName: branchName,
        },
        context
      );
    }
  });
};
