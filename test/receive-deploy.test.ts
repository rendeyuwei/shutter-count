import type {
  ReceiverDependencies,
  SourceFileSystem,
  RunCommand,
  DeploymentOptions,
  TrustFileSystem,
  LogFileSystem,
} from "../scripts/receive-deploy.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { constants } from "node:fs";
import {
  CONFIG_PATH,
  DEPLOY_SCRIPT,
  EXPECTED_CONFIG,
  TRUSTED_DIRECTORY,
  RECEIVER_NODE,
  parseCommand,
  validateConfig,
  validateIdentity,
  validateRun,
  validateJobs,
  validateAuthorization,
  authorizeDeployment,
  deploymentEnvironment,
  verificationEnvironment,
  assertRootOwnedPath,
  receiveDeployment,
  spawnDeployment,
} from "../scripts/receive-deploy.js";

class FakeChild extends EventEmitter {
  kill(_signal?: NodeJS.Signals | number): boolean {
    return true;
  }
}

const sha = "a".repeat(40);
const otherSha = "b".repeat(40);
const originalCommand = `deploy ${sha} 123456 2`;
const command = parseCommand(originalCommand);
const identity = {
  uid: 1001,
  username: "shutter-deploy",
  nodeVersion: "22.23.2",
  execPath: RECEIVER_NODE,
};
const repo = () => ({
  full_name: EXPECTED_CONFIG.repository,
  id: EXPECTED_CONFIG.repositoryId,
});
const validRun = () => ({
  id: 123456,
  run_attempt: 2,
  head_sha: sha,
  head_branch: "main",
  event: "push",
  path: ".github/workflows/ci-deploy.yml",
  repository: repo(),
  head_repository: repo(),
  status: "in_progress",
  conclusion: null,
});
interface JobsFixture {
  total_count: unknown;
  jobs: Record<string, unknown>[];
}
const validJobs = (): JobsFixture => ({
  total_count: 2,
  jobs: [
    {
      name: "test",
      status: "completed",
      conclusion: "success",
      head_sha: sha,
      run_id: 123456,
      run_attempt: 2,
    },
    { name: "deploy", status: "in_progress", conclusion: null },
  ],
});
const response = (value: unknown) =>
  new Response(JSON.stringify(value), { status: 200 });
const absent = () => Object.assign(new Error("absent"), { code: "ENOENT" });

function fixture(overrides: ReceiverDependencies = {}) {
  const events: string[] = [];
  const requests: { url: string; options: RequestInit }[] = [];
  const commands: {
    executable: string;
    args: string[];
    options: Parameters<RunCommand>[2];
  }[] = [];
  const deployments: { args: string[]; options: DeploymentOptions }[] = [];
  const removals: Parameters<SourceFileSystem["rm"]>[] = [];
  const signalSource = new EventEmitter();
  let remoteChecks = 0;
  const dependencies: ReceiverDependencies &
    Required<
      Pick<
        ReceiverDependencies,
        "fileSystem" | "runCommand" | "deploy" | "request"
      >
    > = {
    config: { ...EXPECTED_CONFIG },
    identity: { ...identity },
    signalSource,
    checkInstallation: async () => {
      events.push("installation");
    },
    request: async (url, options) => {
      requests.push({ url, options });
      events.push(url.includes("/jobs?") ? "jobs" : "run");
      return response(url.includes("/jobs?") ? validJobs() : validRun());
    },
    fileSystem: {
      mkdtemp: async (prefix) => {
        events.push("temp");
        assert.equal(prefix, "/tmp/shutter-count-deploy-");
        return "/tmp/shutter-count-deploy-test";
      },
      chmod: async (filename, mode) => {
        assert.equal(filename, "/tmp/shutter-count-deploy-test");
        assert.equal(mode, 0o700);
      },
      mkdir: async (filename, options) => {
        assert.equal(filename, "/tmp/shutter-count-deploy-test/source");
        assert.deepEqual(options, { mode: 0o700 });
      },
      lstat: async () => {
        throw absent();
      },
      rm: async (...args) => {
        events.push("cleanup");
        removals.push(args);
      },
    },
    runCommand: async (executable, args, options) => {
      commands.push({ executable, args, options });
      if (args.includes("ls-remote")) {
        events.push(`main${++remoteChecks}`);
        return `${sha}\trefs/heads/main\n`;
      }
      if (args.includes("rev-parse")) return `${sha}\n`;
      if (args.includes("archive")) events.push("archive");
      if (executable === "/usr/bin/tar") events.push("extract");
      return "";
    },
    deploy: async (args, options) => {
      events.push("deploy");
      deployments.push({ args, options });
    },
    ...overrides,
  };
  return {
    dependencies,
    events,
    requests,
    commands,
    deployments,
    removals,
    signalSource,
  };
}

test("receiver parses only the fixed literal protocol", () => {
  assert.deepEqual(command, {
    sha,
    runId: "123456",
    attempt: "2",
    releaseId: `${sha}-123456-2`,
  });
  for (const bad of [
    undefined,
    null,
    123,
    "",
    `deploy ${sha.toUpperCase()} 1 1`,
    `deploy ${sha.slice(1)} 1 1`,
    `deploy ${sha} 0 1`,
    `deploy ${sha} 01 1`,
    `deploy ${sha} 1 0`,
    `deploy ${sha} 1 01`,
    `deploy ${sha} +1 1`,
    `deploy ${sha} 1 1.0`,
    `deploy ${sha} 1e3 1`,
    `deploy ${sha} 1 1 extra`,
    ` deploy ${sha} 1 1`,
    `deploy  ${sha} 1 1`,
    `${originalCommand}\n`,
    `${originalCommand}\r`,
    `${originalCommand}\r\n`,
    `${originalCommand}\0`,
    `${originalCommand}\t`,
    `${originalCommand}\u2028`,
    `${originalCommand}; touch /tmp/pwn`,
    `${originalCommand} && id`,
    `deploy $(id) 1 1`,
    `deploy ${sha}\n1 1`,
    `deploy\t${sha} 1 1`,
    `${originalCommand} --root /etc`,
    `deploy ${sha} ${"1".repeat(256)} 1`,
  ])
    assert.throws(
      () => parseCommand(bad),
      /Invalid deployment command/,
      String(bad)
    );
});

test("config only accepts the exact root-controlled destination and public repository", () => {
  assert.equal(validateConfig({ ...EXPECTED_CONFIG }), EXPECTED_CONFIG);
  assert.equal(CONFIG_PATH, "/etc/shutter-count/deploy.json");
  for (const key of Object.keys(EXPECTED_CONFIG)) {
    assert.throws(
      () => validateConfig({ ...EXPECTED_CONFIG, [key]: "attacker" }),
      /configuration/,
      key
    );
    const incomplete: Record<string, unknown> = { ...EXPECTED_CONFIG };
    delete incomplete[key];
    assert.throws(() => validateConfig(incomplete), /configuration/, key);
  }
  assert.throws(() =>
    validateConfig({ ...EXPECTED_CONFIG, deployScript: "/tmp/payload" })
  );
  assert.throws(() => validateConfig(Object.create(EXPECTED_CONFIG)));
  assert.throws(() => validateConfig(null));
});

test("identity rejects root, wrong account, and anything but the fixed Node 22 executable", () => {
  validateIdentity(identity);
  for (const change of [
    { uid: 0 },
    { uid: -1 },
    { uid: "1001" },
    { username: "root" },
    { username: "shutter-deploy\n" },
    { nodeVersion: "20.19.0" },
    { nodeVersion: "24.0.0" },
    { execPath: "/tmp/node" },
    { execPath: `${EXPECTED_CONFIG.runtimeBin}/node` },
  ])
    assert.throws(() => validateIdentity({ ...identity, ...change }));
});

test("authorization accepts a successful test during the ongoing deployment run", () => {
  validateAuthorization(validRun(), validJobs(), command);
  validateRun({ ...validRun(), event: "workflow_dispatch" }, command);
});

for (const [name, change] of [
  ["wrong run", { id: 123457 }],
  ["wrong attempt", { run_attempt: 1 }],
  ["wrong commit", { head_sha: otherSha }],
  ["uppercase commit", { head_sha: sha.toUpperCase() }],
  ["wrong branch", { head_branch: "feature" }],
  ["pull request", { event: "pull_request" }],
  ["pull request target", { event: "pull_request_target" }],
  ["scheduled run", { event: "schedule" }],
  ["wrong workflow", { path: ".github/workflows/other.yml" }],
  ["workflow suffix", { path: ".github/workflows/ci-deploy.yml@main" }],
  ["missing repository", { repository: null }],
  ["missing source repository", { head_repository: null }],
  [
    "foreign repository",
    { repository: { ...repo(), full_name: "someone/shutter-count" } },
  ],
  [
    "fork source",
    { head_repository: { ...repo(), full_name: "someone/shutter-count" } },
  ],
  ["recreated repository", { repository: { ...repo(), id: 999 } }],
  ["recreated head repository", { head_repository: { ...repo(), id: 999 } }],
  ["invalid repository ID", { repository: { ...repo(), id: null } }],
  [
    "missing repository ID",
    { repository: { full_name: EXPECTED_CONFIG.repository } },
  ],
  [
    "missing head repository ID",
    { head_repository: { full_name: EXPECTED_CONFIG.repository } },
  ],
  ["unsafe numeric run ID", { id: Number.MAX_SAFE_INTEGER + 1 }],
] as const)
  test(`authorization rejects ${name}`, () => {
    assert.throws(() => validateRun({ ...validRun(), ...change }, command));
  });

for (const [name, mutate] of [
  [
    "failed test",
    (body) => {
      body.jobs[0]!.conclusion = "failure";
    },
  ],
  [
    "skipped test",
    (body) => {
      body.jobs[0]!.conclusion = "skipped";
    },
  ],
  [
    "unfinished test",
    (body) => {
      body.jobs[0]!.status = "in_progress";
    },
  ],
  [
    "renamed test",
    (body) => {
      body.jobs[0]!.name = "test (22)";
    },
  ],
  [
    "duplicate test",
    (body) => {
      body.jobs[1] = { ...body.jobs[0] };
    },
  ],
  [
    "test from wrong commit",
    (body) => {
      body.jobs[0]!.head_sha = otherSha;
    },
  ],
  [
    "test without commit",
    (body) => {
      delete body.jobs[0]!.head_sha;
    },
  ],
  [
    "test from wrong run",
    (body) => {
      body.jobs[0]!.run_id = 99;
    },
  ],
  [
    "test without run",
    (body) => {
      delete body.jobs[0]!.run_id;
    },
  ],
  [
    "test from prior attempt",
    (body) => {
      body.jobs[0]!.run_attempt = 1;
    },
  ],
  [
    "paginated jobs",
    (body) => {
      body.total_count = 101;
    },
  ],
  [
    "short page",
    (body) => {
      body.total_count = 3;
    },
  ],
  [
    "wrong total type",
    (body) => {
      body.total_count = "2";
    },
  ],
  [
    "extra uncounted job",
    (body) => {
      body.total_count = 1;
    },
  ],
  [
    "empty jobs",
    (body) => {
      body.total_count = 0;
      body.jobs = [];
    },
  ],
] satisfies [string, (body: JobsFixture) => void][])
  test(`authorization rejects ${name}`, () => {
    const body = validJobs();
    mutate(body);
    assert.throws(() => validateJobs(body, command));
  });

test("public REST verification pins paths and uses timeout, no redirects, and no authentication", async () => {
  const f = fixture();
  await authorizeDeployment(command, f.dependencies.request);
  assert.deepEqual(
    f.requests.map((item) => item.url),
    [
      "https://api.github.com/repos/rendeyuwei/shutter-count/actions/runs/123456",
      "https://api.github.com/repos/rendeyuwei/shutter-count/actions/runs/123456/attempts/2/jobs?per_page=100",
    ]
  );
  for (const { options } of f.requests) {
    assert.equal(options.redirect, "error");
    assert.equal(options.credentials, "omit");
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(
      Object.keys(options.headers ?? {}).some(
        (key) => key.toLowerCase() === "authorization"
      ),
      false
    );
  }
});

test("API failures, redirects, invalid data and large bodies fail closed without reflecting errors", async () => {
  for (const request of [
    async () => {
      throw new Error("SECRET API failure");
    },
    async () => new Response("SECRET API body", { status: 403 }),
    async () => new Response("SECRET API body", { status: 302 }),
    async () => new Response("SECRET API body", { status: 200 }),
    async () => ({ status: 200, redirected: true, text: async () => "{}" }),
    async () => ({
      status: 200,
      url: "https://attacker.invalid",
      text: async () => "{}",
    }),
    async () => ({
      status: 200,
      text: async () => " ".repeat(2 * 1024 * 1024 + 1),
    }),
  ])
    await assert.rejects(authorizeDeployment(command, request), (error) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        "Public GitHub deployment verification failed"
      );
      return true;
    });
});

test("root-owned trust verification rejects writable paths and symlink ancestors", async () => {
  const file = `${TRUSTED_DIRECTORY}/receive-deploy.mjs`;
  const inspected: string[] = [];
  function fakeFs(
    badPath?: string,
    change: Partial<Awaited<ReturnType<TrustFileSystem["lstat"]>>> = {}
  ): TrustFileSystem {
    return {
      lstat: async (filename: string) => {
        inspected.push(filename);
        return {
          uid: 0,
          mode: 0o755,
          isSymbolicLink: () => false,
          isFile: () => filename === file,
          isDirectory: () => filename !== file,
          ...(filename === badPath ? change : {}),
        };
      },
    };
  }
  await assertRootOwnedPath(file, fakeFs());
  assert.deepEqual(inspected, [
    "/",
    "/usr",
    "/usr/local",
    "/usr/local/libexec",
    TRUSTED_DIRECTORY,
    file,
  ]);
  for (const [filename, change] of [
    [file, { uid: 1001 }],
    [file, { mode: 0o666 }],
    [file, { isSymbolicLink: () => true }],
    [TRUSTED_DIRECTORY, { mode: 0o775 }],
    ["/usr/local", { isSymbolicLink: () => true }],
    ["/usr/local/libexec", { isDirectory: () => false }],
  ] as const)
    await assert.rejects(assertRootOwnedPath(file, fakeFs(filename, change)));
});

test("child environment is allowlisted and never copies client-supplied settings or secrets", () => {
  const env = deploymentEnvironment();
  assert.equal(env.PATH, "/opt/node-v22.23.2-linux-x64/bin:/usr/bin:/bin");
  assert.equal(env.HOME, "/var/lib/shutter-deploy");
  assert.equal(env.PM2_HOME, "/var/lib/shutter-deploy/.pm2");
  assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(env.GIT_CONFIG_SYSTEM, "/dev/null");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  for (const name of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "SSH_AUTH_SOCK",
    "SSH_ORIGINAL_COMMAND",
    "NODE_OPTIONS",
    "BASH_ENV",
    "LD_PRELOAD",
    "HTTPS_PROXY",
    "DEPLOY_ROOT",
  ])
    assert.equal(Object.hasOwn(env, name), false, name);
});

test("receiver verifies exact source and current main twice then calls only the trusted script", async () => {
  const f = fixture();
  const result = await receiveDeployment(originalCommand, f.dependencies);
  assert.deepEqual(result, { sha, releaseId: `${sha}-123456-2` });
  assert.deepEqual(f.events, [
    "installation",
    "run",
    "jobs",
    "main1",
    "temp",
    "archive",
    "extract",
    "main2",
    "deploy",
    "cleanup",
  ]);
  assert.equal(f.deployments.length, 1);
  assert.deepEqual(f.deployments[0]!.args, [
    "/tmp/shutter-count-deploy-test/source",
    "/opt/shutter-count",
    sha,
    `${sha}-123456-2`,
    "http://127.0.0.1:3020/shutter",
    "https://rende.fun/shutter",
  ]);
  assert.deepEqual(f.deployments[0]!.options.env, deploymentEnvironment());
  assert.equal(
    f.commands.filter((item) => item.args.includes("ls-remote")).length,
    2
  );
  for (const item of f.commands) {
    assert.ok(["/usr/bin/git", "/usr/bin/tar"].includes(item.executable));
    assert.deepEqual(item.options.env, verificationEnvironment());
    assert.equal(Object.hasOwn(item.options, "shell"), false);
  }
  const fetchArgs = f.commands.find((item) =>
    item.args.includes("fetch")
  )!.args;
  assert.deepEqual(fetchArgs.slice(-6), [
    "fetch",
    "--depth=1",
    "--no-tags",
    "--no-recurse-submodules",
    "https://github.com/rendeyuwei/shutter-count.git",
    sha,
  ]);
  assert.ok(fetchArgs.includes("core.hooksPath=/dev/null"));
  assert.ok(fetchArgs.includes("credential.helper="));
  assert.ok(fetchArgs.includes("http.followRedirects=false"));
  const archiveArgs = f.commands.find((item) =>
    item.args.includes("archive")
  )!.args;
  assert.deepEqual(archiveArgs.slice(-5), [
    "archive",
    "--format=tar",
    "--output",
    "/tmp/shutter-count-deploy-test/source.tar",
    sha,
  ]);
  assert.deepEqual(f.removals, [
    ["/tmp/shutter-count-deploy-test", { recursive: true, force: true }],
  ]);
  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"])
    assert.equal(f.signalSource.listenerCount(signal), 0);
});

test("invalid command, host configuration and identity cannot reach GitHub or subprocesses", async () => {
  for (const [input, override] of [
    [`${originalCommand}\n`, {}],
    [originalCommand, { config: { ...EXPECTED_CONFIG, root: "/tmp" } }],
    [originalCommand, { identity: { ...identity, uid: 0 } }],
  ] as const) {
    const f = fixture(override);
    await assert.rejects(receiveDeployment(input, f.dependencies));
    assert.equal(f.requests.length, 0);
    assert.equal(f.commands.length, 0);
    assert.equal(f.deployments.length, 0);
  }
});

test("failed GitHub authorization prevents fetching and activation", async () => {
  const f = fixture({
    request: async () => response({ ...validRun(), head_sha: otherSha }),
  });
  await assert.rejects(receiveDeployment(originalCommand, f.dependencies));
  assert.equal(f.commands.length, 0);
  assert.equal(f.deployments.length, 0);
  assert.equal(f.removals.length, 0);
});

for (const checkNumber of [1, 2])
  test(`stale main at check ${checkNumber} never activates`, async () => {
    const f = fixture();
    const run = f.dependencies.runCommand;
    let checks = 0;
    f.dependencies.runCommand = async (...args) => {
      const output = await run(...args);
      return args[1].includes("ls-remote") && ++checks === checkNumber
        ? `${otherSha}\trefs/heads/main\n`
        : output;
    };
    await assert.rejects(
      receiveDeployment(originalCommand, f.dependencies),
      /no longer current main/
    );
    assert.equal(f.deployments.length, 0);
    assert.equal(f.events.includes("temp"), checkNumber === 2);
    assert.equal(f.removals.length, checkNumber === 2 ? 1 : 0);
  });

test("an extra ls-remote row is not accepted as verification", async () => {
  const f = fixture({
    runCommand: async () =>
      `${sha}\trefs/heads/main\n${otherSha}\trefs/heads/main\n`,
  });
  await assert.rejects(
    receiveDeployment(originalCommand, f.dependencies),
    /current main/
  );
  assert.equal(f.deployments.length, 0);
});

test("mismatched FETCH_HEAD fails before archiving and removes temporary source", async () => {
  const f = fixture();
  const run = f.dependencies.runCommand;
  f.dependencies.runCommand = async (...args) =>
    args[1].includes("rev-parse") ? `${otherSha}\n` : run(...args);
  await assert.rejects(
    receiveDeployment(originalCommand, f.dependencies),
    /does not match/
  );
  assert.equal(f.events.includes("archive"), false);
  assert.equal(f.deployments.length, 0);
  assert.equal(f.removals.length, 1);
});

for (const step of ["fetch", "archive", "-xf"])
  test(`source ${step} failure cleans up without activation`, async () => {
    const f = fixture();
    const run = f.dependencies.runCommand;
    f.dependencies.runCommand = async (...args) => {
      if (args[1].includes(step)) throw new Error("simulated source failure");
      return run(...args);
    };
    await assert.rejects(receiveDeployment(originalCommand, f.dependencies));
    assert.equal(f.deployments.length, 0);
    assert.equal(f.removals.length, 1);
  });

for (const name of [".git", "node_modules"])
  test(`exported ${name} is rejected even if it is a symlink`, async () => {
    const f = fixture();
    f.dependencies.fileSystem.lstat = async (filename) => {
      if (filename.endsWith(`/${name}`)) return { isSymbolicLink: () => true };
      throw absent();
    };
    await assert.rejects(
      receiveDeployment(originalCommand, f.dependencies),
      /forbidden/
    );
    assert.equal(f.deployments.length, 0);
    assert.equal(f.removals.length, 1);
  });

test("cleanup failure after successful deployment reports completion and never redeploys", async () => {
  const f = fixture();
  f.dependencies.fileSystem.rm = async () => {
    throw new Error("denied");
  };
  await assert.rejects(
    receiveDeployment(originalCommand, f.dependencies),
    /Deployment completed.*do not retry automatically/
  );
  assert.equal(f.deployments.length, 1);
});

test("failed deployment is cleaned up once and is never retried", async () => {
  let calls = 0;
  const f = fixture({
    deploy: async () => {
      calls++;
      throw new Error("unknown deployment outcome");
    },
  });
  await assert.rejects(
    receiveDeployment(originalCommand, f.dependencies),
    /unknown deployment outcome/
  );
  assert.equal(calls, 1);
  assert.equal(f.removals.length, 1);
});

test("an interrupted preparation waits for its operation then cleans up without deploying", async () => {
  const f = fixture();
  const run = f.dependencies.runCommand;
  f.dependencies.runCommand = async (...args) => {
    if (args[1].includes("fetch")) f.signalSource.emit("SIGHUP");
    return run(...args);
  };
  await assert.rejects(
    receiveDeployment(originalCommand, f.dependencies),
    /interrupted/
  );
  assert.equal(f.deployments.length, 0);
  assert.equal(f.removals.length, 1);
});

for (const firstSignal of ["SIGHUP", "SIGTERM"])
  test(`${firstSignal} is forwarded once and cleanup waits for deployment rollback to exit`, async () => {
    const f = fixture();
    const child = new FakeChild();
    const sent: (NodeJS.Signals | number | undefined)[] = [];
    let spawned!: () => void;
    const ready = new Promise<void>((resolve) => {
      spawned = resolve;
    });
    let logClosed = false;
    const logFs: LogFileSystem = {
      open: async (filename, flags, mode) => {
        assert.equal(
          filename,
          `/opt/shutter-count/deploy-${command.releaseId}.log`
        );
        assert.equal(
          flags,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW
        );
        assert.equal(mode, 0o600);
        return {
          fd: 123,
          close: async () => {
            logClosed = true;
          },
        };
      },
    };
    child.kill = (signal) => {
      sent.push(signal);
      return true;
    };
    f.dependencies.deploy = (args, options) =>
      spawnDeployment(args, {
        ...options,
        fileSystem: logFs,
        spawnProcess: (executable, argv, childOptions) => {
          assert.equal(executable, "/usr/bin/bash");
          assert.equal(argv[0], DEPLOY_SCRIPT);
          assert.equal(argv.length, 7);
          assert.equal(childOptions.cwd, EXPECTED_CONFIG.home);
          assert.equal(childOptions.detached, true);
          assert.deepEqual(childOptions.stdio, ["ignore", 123, 123]);
          assert.deepEqual(childOptions.env, deploymentEnvironment());
          assert.equal(Object.hasOwn(childOptions, "shell"), false);
          spawned();
          return child;
        },
      });
    const pending = receiveDeployment(originalCommand, f.dependencies);
    const rejected = assert.rejects(
      pending,
      /inspect host state before retrying/
    );
    await ready;
    f.signalSource.emit(firstSignal);
    f.signalSource.emit("SIGTERM");
    f.signalSource.emit("SIGHUP");
    assert.deepEqual(sent, [firstSignal]);
    assert.equal(f.removals.length, 0);
    assert.equal(logClosed, false);
    child.emit("exit", 1, null);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      f.removals.length,
      0,
      "even exit must not race outstanding child pipes"
    );
    assert.equal(logClosed, false);
    child.emit("close", 1, null);
    await rejected;
    assert.equal(f.removals.length, 1);
    assert.equal(logClosed, true);
    assert.equal(f.signalSource.listenerCount(firstSignal), 0);
  });

test("a child error also waits for close before cleaning up potentially live deployment", async () => {
  const f = fixture();
  const child = new FakeChild();
  child.kill = () => true;
  let spawned!: () => void;
  const ready = new Promise<void>((resolve) => {
    spawned = resolve;
  });
  f.dependencies.deploy = (args, options) =>
    spawnDeployment(args, {
      ...options,
      fileSystem: { open: async () => ({ fd: 123, close: async () => {} }) },
      spawnProcess: () => {
        spawned();
        return child;
      },
    });
  const pending = receiveDeployment(originalCommand, f.dependencies);
  const rejected = assert.rejects(
    pending,
    /inspect host state before retrying/
  );
  await ready;
  child.emit("error", new Error("could not signal live process"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.removals.length, 0);
  child.emit("close", 0, null);
  await rejected;
  assert.equal(f.removals.length, 1);
});

test("existing or symlinked deployment log fails closed without spawning or retrying", async () => {
  const f = fixture();
  let spawns = 0;
  f.dependencies.deploy = (args, options) =>
    spawnDeployment(args, {
      ...options,
      fileSystem: {
        open: async () => {
          throw Object.assign(new Error("existing log"), { code: "EEXIST" });
        },
      },
      spawnProcess: () => {
        spawns++;
        throw new Error("must not spawn");
      },
    });
  await assert.rejects(
    receiveDeployment(originalCommand, f.dependencies),
    /log already exists/
  );
  assert.equal(spawns, 0);
  assert.equal(f.removals.length, 1);
});

test("successful child output goes only to the persistent host log and closes after exit", async () => {
  const f = fixture();
  const child = new FakeChild();
  let closed = false;
  let spawned!: () => void;
  const ready = new Promise<void>((resolve) => {
    spawned = resolve;
  });
  f.dependencies.deploy = (args, options) =>
    spawnDeployment(args, {
      ...options,
      fileSystem: {
        open: async () => ({
          fd: 123,
          close: async () => {
            closed = true;
          },
        }),
      },
      spawnProcess: (_executable, _args, options) => {
        assert.deepEqual(options.stdio, ["ignore", 123, 123]);
        spawned();
        return child;
      },
    });
  const pending = receiveDeployment(originalCommand, f.dependencies);
  await ready;
  assert.equal(closed, false);
  child.emit("close", 0, null);
  await pending;
  assert.equal(closed, true);
  assert.equal(f.removals.length, 1);
});

test("verification gate uses a protected interpreter and system-only tool PATH", () => {
  assert.equal(RECEIVER_NODE, "/usr/local/libexec/shutter-count/receive-node");
  assert.equal(verificationEnvironment().PATH, "/usr/bin:/bin");
  assert.equal(
    deploymentEnvironment().PATH,
    `${EXPECTED_CONFIG.runtimeBin}:/usr/bin:/bin`
  );
});
