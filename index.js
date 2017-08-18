const fetch = require('node-fetch');
const api = require('chuck-norris-api');

const cloudApiId = process.env.DOCKER_CLOUD_API_ID;
const cloudApiSecret = process.env.DOCKER_CLOUD_API_SECRET;
const apiUrl = `https://${cloudApiId}:${cloudApiSecret}@cloud.docker.com`;
const headers = {
  Accept: 'application/json',
  'Content-Type': 'application/json',
};
const DOCKER_CLOUD_BOT_LOGIN = 'docker-cloud-bot[bot]';

function getStackUrlByName(name) {
  return `${apiUrl}/api/app/v1/stack?name=${name}`;
}

function getCommonOptions() {
  return { headers: headers };
}

function processResponse(response) {
  let isOk = response.ok;

  return response.text().then(text => {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      isOk = false;
    }

    if (isOk) return parsed;

    throw parsed || text;
  });
}

function getDockerServiceByBranch(branchName) {
  return fetch(getStackUrlByName(branchName), getCommonOptions())
  .then(processResponse)
  .then(result => {
    if (!result.objects.length) {
      // TODO create a comment informing the deploy is not ready yet
      console.log('There is no stack with the provided name.');
      return null;
    }
    return result.objects[0];
  })
  .catch(e => console.log(e));
}

function createDockerCloudBotComment(branchName, context) {
  getDockerServiceByBranch(branchName).then(result => {
    if (result && result.services.length > 0)
      fetch(apiUrl + result.services[0], getCommonOptions())
      .then(processResponse)
      .then(service => {
        api.getRandom({}).then(function (data) {
          if (service['container_ports'].length > 0) {
            const url = service['container_ports'][0]['endpoint_uri'].replace('tcp', 'http');
            const params = context.issue({
              body: `${data.value.joke}\n${url}`
            });
            return context.github.issues.createComment(params);
          }
        });
      });
  })
  .catch(err => console.log(err));
}

module.exports = (robot) => {
  robot.on('pull_request', async context => {
    // TODO when receiving events like close or merge, we can remove the stack
    const branchName = context.payload.pull_request.head.ref;
    // Check if there is already a comment from the bot, if not create a new one
    if (context.payload.action === 'synchronize') {
      context.github.issues.getComments({
        owner: context.payload.pull_request.user.login,
        repo: context.payload.repository.name ,
        number: context.payload.number
      }).then(comments => {
        const botMessage = comments.data.find(comment => comment.user.login === DOCKER_CLOUD_BOT_LOGIN);
        if (!botMessage) {
          createDockerCloudBotComment(branchName, context);
        }
      });
    }
    if (context.payload.action === 'opened')
      createDockerCloudBotComment(branchName, context);
  });
};
