const puppeteer = require('puppeteer');
const { queue } = require('async');
const { random } = require('lodash');
const minimist = require('minimist');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const moment = require('moment');
const colors = require('colors');

const mkdir = promisify(fs.mkdir);

let abort = false;

class LoginContext {
  constructor({ index, startUrl, user, outputPath, screenshot }) {
    this.index = index;
    this.startUrl = startUrl;
    this.user = user;

    this.paddedIndex = this.index.toString().padStart(3, '0');
    this.outputPath = outputPath ? path.join(outputPath, `iteration-${this.paddedIndex}`) : undefined;
    this.takeScreenshots = screenshot;
  }

  async info(message) {
    console.info(`${this.paddedIndex}: ${message}`);
  }

  async error(message) {
    console.error(`${this.paddedIndex}: ${message}`);
  }

  async screenshot(page, name) {
    if (!this.takeScreenshots || !this.outputPath) {
      return;
    }

    try {
      await mkdir(this.outputPath);
    } catch (e) {
      if (e.code !== 'EEXIST') {
        throw e;
      }
    }

    const filePath = path.join(this.outputPath, `${name}.png`);
    await page.screenshot({ path: filePath });
  }
}

class AsyncWritableStream {
  constructor(path) {
    this.path = path;
    this.stream = fs.createWriteStream(path);
  }

  async write(text, encoding = 'utf8') {
    return new Promise((resolve, reject) => {
      this.stream.write(text, encoding, (e) => {
        if (e) {
          reject(e);
        } else {
          resolve();
        }
      });
    });
  }

  async end() {
    return new Promise((resolve, reject) => {
      this.stream.end((e) => {
        if (e) {
          reject(e);
        } else {
          resolve();
        }
      });
    });
  }
}

const mapUsernamePasswordArgIntoArray = (arg, users) => {
  const splitArg = (unpw) => {
    const index = unpw.indexOf(':');
    return {
      username: unpw.substr(0, index),
      password: unpw.substr(index + 1),
    };
  };

  if (arg instanceof Array) {
    const x = arg.map(splitArg);
    users.push(...x);
  } else {
    users.push(splitArg(arg));
  }
};
const readArgs = () => {
  const argv = minimist(process.argv);

  let startUrl = argv.starturl;
  if (!startUrl) {
    startUrl = argv.s;
  }

  let logins = argv.logins;
  if (!logins) {
    logins = argv.l;
  }
  if (logins) {
    logins = parseInt(logins);
  }
  if (isNaN(logins)) {
    logins = undefined;
  }

  let concurrency = argv.concurrency;
  if (!concurrency) {
    concurrency = argv.c;
  }
  if (concurrency) {
    concurrency = parseInt(concurrency);
  }
  if (isNaN(concurrency)) {
    concurrency = undefined;
  }

  let output = argv.output;
  if (!output) {
    output = argv.o;
  }

  let screenshot = argv.screenshot;
  if (!screenshot) {
    screenshot = argv.ss;
  }

  let users = [];
  if (argv.u) {
    mapUsernamePasswordArgIntoArray(argv.u, users);
  }
  if (argv.user) {
    mapUsernamePasswordArgIntoArray(argv.user, users);
  }

  return {
    startUrl,
    logins,
    concurrency,
    users,
    output,
    screenshot: screenshot || false,
  }
};
const login = async (context) => {
  await context.info('Launching browser');
  const browser = await puppeteer.launch();
  let page;
  try {
    page = await browser.newPage();
    page.setViewport({ width: 1024, height: 768 });
    page.setDefaultNavigationTimeout(60000);

    await context.info(`Navigate to ${context.startUrl}`);
    await page.goto(context.startUrl);
    await context.screenshot(page, '001-StartPage');
    context.startTime = Date.now();

    await context.info(`Complete login form as ${context.user.username}`);
    await (await page.$('#username')).type(context.user.username);
    await (await page.$('#password')).type(context.user.password);
    await context.screenshot(page, '002-CredentialsEntered');
    await (await page.$('button')).click();
    await context.screenshot(page, '003-LoginClicked');

    await context.info('Wait to redirect back to RP');
    await page.waitForNavigation();
    await context.screenshot(page, '004-AfterRedirect');

    const url = page.url();
    if (!url.toLowerCase().startsWith(context.startUrl)) {
      throw new Error(`Ended on wrong page - ${url}`)
    }
    context.finishTime = Date.now();
    await browser.close();
  } catch (e) {
    if (page) {
      await context.screenshot(page, '999-Errored');
    }
    await browser.close();
    throw e;
  }
};
const processLogin = (context, callback) => {
  if (abort) {
    return;
  }
  login(context)
    .then(() => callback())
    .catch((e) => callback(e));
};
const doLogins = (opts) => {
  return new Promise((resolve) => {
    const contexts = [];
    const q = queue(processLogin, opts.numberOfConcurrentUsers);
    q.drain = () => {
      resolve(contexts.map(c => ({
        index: c.index,
        startTime: c.startTime,
        finishTime: c.finishTime,
        failureReason: c.failureReason,
      })));
    };

    for (let i = 0; i < opts.numberOfLogins; i++) {
      const context = new LoginContext({
        index: i,
        startUrl: opts.startUrl,
        user: opts.users[random(opts.users, 0, opts.users.length - 1)],
        outputPath: opts.outputPath,
      });
      contexts.push(context);
      q.push(context, (e) => {
        if (e) {
          context.failureReason = e.toString();
          context.error(e.toString());
        } else {
          context.info(`Success`);
        }
      });
    }
  });
};
const saveResults = async (results, outputPath) => {
  let stream;
  if (outputPath) {
    try {
      await mkdir(outputPath);
    } catch (e) {
      if (e.code !== 'EEXIST') {
        throw e;
      }
    }

    stream = new AsyncWritableStream(path.join(outputPath, `results.csv`));

    await stream.write('Iteration,Start time,Finish Time,Duration,Failure reason', 'utf8');
  }

  let minDuration;
  let maxDuration;
  let totalDuration = 0;
  let errorCount = 0;
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const durationMs = result.finishTime ? result.finishTime - result.startTime : undefined;
    const duration = durationMs ? durationMs / 1000 : undefined;
    if (duration) {
      totalDuration += duration;
      if (!minDuration || duration < minDuration) {
        minDuration = duration;
      }
      if (!maxDuration || duration > maxDuration) {
        maxDuration = duration;
      }
    }
    if (result.failureReason) {
      errorCount++;
    }

    if (stream) {
      const start = moment(result.startTime).format('D MMM YYYY HH:mm:SS');
      const finish = result.finishTime ? moment(result.finishTime).format('D MMM YYYY HH:mm:SS') : '';

      await stream.write(`\n${result.index},${start},${finish},${duration || ''},${result.failureReason || ''}`, 'utf8');
    }
  }

  const iterationCount = results.length;
  const successCount = iterationCount - errorCount;
  const successRate = (successCount / iterationCount) * 100;
  const avgDuration = totalDuration / successCount;
  console.info(colors.magenta(`  Total number of logins: ${iterationCount}`));
  console.info(colors.magenta(' '));
  console.info(colors.magenta(`  Successful logins:      ${successCount}`));
  console.info(colors.magenta(`  Failed logins:          ${errorCount}`));
  console.info(colors.magenta(`  Success rate:           ${successRate}%`));
  console.info(colors.magenta(' '));
  console.info(colors.magenta(`  Average duration:       ${avgDuration}s`));
  console.info(colors.magenta(`  Minimum duration:       ${minDuration}s`));
  console.info(colors.magenta(`  Maximum duration:       ${maxDuration}s`));

  if (stream) {
    await stream.end();
    console.info(`Results saved to ${stream.path}`);
  }

};

process.on('SIGINT', () => {
  console.log("Received SIGINT. Aborting...");

  abort = true;

  setTimeout(() => process.exit(), 5000);
});

const args = readArgs();
if (!args.users || args.users.length === 0) {
  throw new Error('Must specify at least 1 user');
}
const opts = {
  startUrl: args.startUrl || 'https://signin-dev-pfllnx-as.azurewebsites.net',
  numberOfLogins: args.logins || 40,
  numberOfConcurrentUsers: args.concurrency || 2,
  users: args.users,
  outputPath: args.output,
  screenshot: args.screenshot || false,
};


doLogins(opts)
  .then((results) => {
    if (opts.outputPath) {
      console.info('Finalising...');
      saveResults(results, opts.outputPath)
        .catch(e => console.error(`Error saving results - ${e.message}`));
    } else {
      console.info('done');
    }
  })
  .catch((e) => console.error(e.message));
