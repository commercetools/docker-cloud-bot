const fetch = require('node-fetch');

const validateEnvironment = keys => {
  keys.forEach(key => {
    const value = process.env[key];
    if (!value) throw new Error(`Missing '${key}' environment variable`);
  });
};
validateEnvironment(['DOCKERCLOUD_USER', 'DOCKERCLOUD_APIKEY']);

const dockerCloudUser = process.env.DOCKERCLOUD_USER;
const dockerCloudApiKey = process.env.DOCKERCLOUD_APIKEY;
const apiUrl = `https://${dockerCloudUser}:${dockerCloudApiKey}@cloud.docker.com`;
const headers = {
  Accept: 'application/json',
  'Content-Type': 'application/json',
};

const getStackUrlForApi = id => `${apiUrl}/api/app/v1/stack/${id || ''}`;
const getStackUrlForWebApp = stack =>
  `https://cloud.docker.com/app/${dockerCloudUser}/stack/${stack.uuid}`;

const getCurrentStacks = () =>
  fetch(getStackUrlForApi(), { headers }).then(processResponse);

const getStackByName = async stackName => {
  const stacks = await getCurrentStacks();
  return stacks.objects.find(s => s.name === stackName);
};

const getStackServiceUrls = async stack => {
  const runningStackServices = await Promise.all(
    stack.services.map(service =>
      fetch(apiUrl + service, { headers }).then(processResponse)
    )
  );

  return runningStackServices.reduce((acc, service) => {
    const serviceName = service.name;
    const serviceUrls = [];
    service['container_ports'].forEach(container => {
      if (container['endpoint_uri']) {
        serviceUrls.push(container['endpoint_uri'].replace('tcp', 'http'));
      }
    });
    return Object.assign({}, acc, { [serviceName]: serviceUrls });
  }, {});
};

const delay = ms =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

const formatState = state => {
  const key = state.toLowerCase();
  if (key === 'not running' || key === 'stopped' || key === 'terminated')
    return state;

  if (key === 'running') return state;

  if (key === 'partly running') return state;

  return state;
};

const createRequestOptions = (options = {}) => {
  if (!options.body) return { headers, method: options.method || 'POST' };

  const serialized = JSON.stringify(options.body);
  /* eslint-disable prefer-object-spread/prefer-object-spread */
  return {
    method: options.method || 'POST',
    body: serialized,
    headers: Object.assign({}, headers, {
      'Content-length': Buffer.byteLength(serialized),
    }),
  };
  /* eslint-enable prefer-object-spread/prefer-object-spread */
};

const calculateSuggestedPort = (servicePorts, minRangePort) => {
  return Object.keys(servicePorts).reduce((acc, port) => {
    let suggested = acc;
    // eslint-disable-next-line
    while (~servicePorts.indexOf(suggested))
      // eslint-disable-next-line
      suggested++;
    return suggested;
  }, minRangePort);
};

module.exports = robot => {
  const startStack = async (stack, retry) => {
    const retryCount = retry || 10;
    await fetch(
      `${getStackUrlForApi(stack.uuid)}/start/`,
      createRequestOptions()
    ).then(processResponse);
    return waitForRunning(stack.uuid, retryCount);
  };

  const redeployStack = async existingStack => {
    robot.log(`[stack - ${existingStack.name}] Stack will be redeployed`);
    await fetch(
      `${getStackUrlForApi(existingStack.uuid)}/redeploy/?reuse_volumes=true`,
      createRequestOptions()
    ).then(processResponse);
    robot.log(`[stack - ${existingStack.name}] Waiting for stack to start...`);
    const retryCount = 10;
    return waitForRunning(existingStack.uuid, retryCount);
  };

  const terminateStack = existingStack => {
    robot.log(
      `[stack - ${existingStack.name}] Stack will be terminated`
    );
    return fetch(
      `${getStackUrlForApi(existingStack.uuid)}`,
      createRequestOptions({ method: 'DELETE' })
    ).then(processResponse);
  };

  // meta: {
  //   filterBranches,
  //   stack: {
  //     imageRepo,
  //     innerPort,
  //     outerPortRangeMin,
  //     template: {
  //       name,
  //       target_num_containers,
  //       container_envvars: [],
  //       tags: [],
  //       autorestart,
  //     }
  //   }
  // }
  const createStack = async (stackName, meta) => {
    robot.log(`[stack - ${stackName}] Stack will be created`);
    const stacks = await getCurrentStacks();
    const activeStacks = stacks.objects.filter(
      stack =>
        stack.state.toLowerCase() !== 'terminating' ||
        stack.state.toLowerCase() !== 'terminated'
    );

    // Flatten the services list for all stacks
    const filteredServices = activeStacks.reduce(
      (acc, s) => acc.concat(s.services),
      []
    );
    const services = await Promise.all(
      // Expand all services
      filteredServices.map(service =>
        fetch(apiUrl + service, { headers }).then(processResponse)
      )
    );
    const servicePorts = services
      // Filter only services that belong to the same group (`service.name`)
      .filter(service => service.name === meta.stack.template.name)
      // Return a flat list of ports from all services
      .reduce(
        (acc, service) =>
          acc.concat(
            service['container_ports'].map(ports => ports['outer_port'])
          ),
        []
      );

    robot.log(
      `[stack - ${stackName}] Checking for currently used ports`,
      servicePorts
    );
    const suggestedPort = calculateSuggestedPort(
      servicePorts,
      meta.stack.outerPortRangeMin
    );
    robot.log(`[stack - ${stackName}] Suggested port`, suggestedPort);

    // TODO: allow list of templates?
    const payload = {
      name: stackName, // human-readable name
      nickname: stackName, // user-friendly name
      services: [
        Object.assign(
          {
            image: `${meta.stack.imageRepo}:${stackName}`,
            container_ports: [
              {
                inner_port: parseInt(meta.stack.innerPort, 10),
                outer_port: parseInt(suggestedPort, 10),
              },
            ],
          },
          meta.stack.template
        ),
      ],
    };

    const newStack = await fetch(
      getStackUrlForApi(),
      createRequestOptions({ body: payload })
    ).then(processResponse);

    robot.log(`[stack - ${stackName}] Waiting for stack to start...`);
    const retryCount = 10;
    return waitForRunning(newStack.uuid, retryCount);
  };

  function waitForRunning(id, retry) {
    // eslint-disable-next-line
    if (!retry--) throw new Error('Too many retries');

    // Poll stack to check for its status
    return delay(5000)
      .then(() => fetch(getStackUrlForApi(id), { headers }))
      .then(processResponse)
      .then(stack => {
        // Stack is running, continue
        if (stack.state.toLowerCase() === 'running') return stack;

        // Stack is starting, just wait
        if (
          stack.state.toLowerCase() === 'starting' ||
          stack.state.toLowerCase() === 'redeploying'
        ) {
          robot.log(
            `[stack - ${stack.name}] Stack state: ${formatState(
              stack.state
            )}. Hold on...`
          );
          // eslint-disable-next-line
          retry++; // set the retry back to 1 loop
          return waitForRunning(id, retry);
        }

        robot.log(
          `[stack - ${stack.name}] (Retry ${retry}) - Stack state: ${formatState(
            stack.state
          )}`
        );

        // Stack has been terminated, abort
        if (stack.state.toLowerCase() === 'terminated')
          throw new Error('Aborting, stack has been terminated!');

        // Stack is not running, try to start it
        if (stack.state.toLowerCase() === 'not running') {
          robot.log(
            `[stack - ${stack.name}] Stack not running, trying to start it...`
          );

          return startStack(stack, retry);
        }

        // Poll again after 5sec
        return waitForRunning(id, retry);
      });
  }

  return {
    getStackUrlForWebApp,
    getStackByName,
    getStackServiceUrls,
    createStack,
    redeployStack,
    terminateStack,
  };
};

async function processResponse(response) {
  let isOk = response.ok;
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    isOk = false;
  }

  if (isOk) return parsed;

  throw parsed || text;
}
