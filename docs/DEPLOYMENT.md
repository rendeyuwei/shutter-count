# Restricted SSH releases

[English](DEPLOYMENT.md) | [简体中文](DEPLOYMENT.zh-CN.md)

## Release flow

The `Test and deploy` workflow tests pull requests and every `main` update on Node 22. After its `test` job succeeds, an enabled main deployment enters the `production` environment and sends just:

```text
deploy <40-character commit SHA> <GitHub run ID> <run attempt>
```

The SSH identity is always `shutter-deploy`. The client cannot choose a repository, server path, executable, environment or upload a script. The administrator-installed receiver independently checks the fixed public repository's current `main`, the exact GitHub run/attempt and its successful `test` job. GitHub API errors or rate limits fail closed. No GitHub token is stored on the server.

The receiver fetches the exact commit, verifies the object and extracts a clean archive. The host installs locked dependencies and reruns tests before switching `current`. The root-managed release script checks `main` again just before activation, atomically changes the symlink, restarts only the verified Shutter PM2 ID, and checks the local/public page, ExifTool and exact running revision. Failure restores the previous release and verifies its local health. Old releases are retained.

GitHub deployment concurrency does not cancel an active release; a server `flock` also serializes releases. A newer main commit makes an older queued/preparing release obsolete. Pending GitHub jobs may be replaced, so this converges on the latest tested commit rather than deploying every intermediate commit. PM2 uses one process: a brief restart is expected, not zero downtime.

## Build prerequisite for TypeScript releases

The application now starts from `dist/`. Before deploying this migration, an administrator must install the reviewed release-control artifacts from `dist/trusted/` into the trusted directory. The existing installed release script does not update when this repository changes and cannot build the new application with production dependencies alone.

The new script runs `npm ci`, type checking, a Node/Vite build, compiled tests, then `npm prune --omit=dev` before switching the release. Failures in any preparation step leave `current` untouched. The stable `current/bin/start.mjs` bootstrap runs compiled code with only production dependencies. `REVISION` is copied into the build output for exact-revision health checks. The receiver and trusted health checker retain their fixed filenames. Node checks formerly embedded in Bash now live in the separately installed `deploy-guard.mjs`.

### Separate administrator upgrade for this migration

Run `npm ci && npm run typecheck && npm run build:trusted` from reviewed source. The four `.mjs` bundles in `dist/trusted/` import only Node builtins and include `SHA256SUMS`. The receiver and helper implementation/dependencies are self-contained and must not resolve them from application-writable directories. The PM2 guard still evaluates the reviewed candidate's `ecosystem.config.cjs` under the dedicated application account; deployment preparation also runs the candidate's dependency hooks and tests under that account.

1. Record the real current-release path/SHA and back up the installed receiver, checker, release script and PM2 configuration to an administrator-controlled location.
2. Pause automatic deployment during a maintenance window if enabled, and verify no release holds the lock. Review the bundles/manifest and install `receive-deploy.mjs`, `check-deploy.mjs`, `deploy-guard.mjs` and `deploy-release.sh` as root-owned mode-0755 files under `/usr/local/libexec/shutter-count/`. Preserve the verified fixed launcher, `receive-node` and dedicated account configuration.
3. Set `kill_timeout: 25000` in the host PM2 configuration, then have its owner reload only Shutter using the verified stable configuration. Verify the live `pm2_env.kill_timeout`, interpreter, current cwd, `current/bin/start.mjs` and environment. Editing a configuration file does not update the running PM2 settings; the new release guard rejects mismatches.
4. Verify host Node 22, build capacity and timeout budget. Before restoring automatic deployment, validate the CI-tested migration release's local/public exact SHA and a health-triggered rollback. The built and pruned production app runs without tsx, TypeScript or Vite.

If the control-file upgrade fails, the administrator restores the trusted-file and PM2 configuration backups. Application activation failures restore the previous `current` through the release script. A failed rollback health check requires pausing subsequent releases and inspecting the current SHA, single PM2 process and logs. Restoring control files and restoring an app release are separate operations.

This change has only been implemented and tested locally; these host operations have not been performed. See [PM2's shutdown-timeout documentation](https://pm2.keymetrics.io/docs/usage/signals-clean-restart/).

## Server prerequisites and administrator setup

This is an existing-deployment updater, not an automatic server provisioner. The example configuration in [`deploy/deploy.example.json`](../deploy/deploy.example.json) binds this Shutter installation. Treat values as requirements to verify, not evidence that setup has completed.

- Dedicated `shutter-deploy` account, no sudo, locked password, no privileged groups; only its own app/state directories writable.
- Node 22 at `/opt/node-v22.23.2-linux-x64/bin`, npm, PM2, Git, Bash, GNU coreutils/tar and `flock`.
- `/opt/shutter-count/current` points into its real `releases/` directory. Exactly one online Shutter process uses that stable working directory and `current/bin/start.mjs`, with the committed environment and Node 22+.
- A root-managed `pm2-shutter-deploy.service` starts only this account's PM2 using `/etc/shutter-count/ecosystem.config.cjs`. Root PM2 startup/dump/fallback files must not retain Shutter references after ownership migration. Never run `pm2 save`, `restart all` or a root deployment.
- Existing loopback `http://127.0.0.1:3020/shutter` and public `https://rende.fun/shutter` routing. Ordinary releases do not edit nginx or firewall rules.

After explicit approval, an administrator installs reviewed copies of `dist/trusted/receive-deploy.mjs`, `dist/trusted/deploy-release.sh`, `dist/trusted/check-deploy.mjs` and `dist/trusted/deploy-guard.mjs` under `/usr/local/libexec/shutter-count/`, plus `deploy/deploy.example.json` as `/etc/shutter-count/deploy.json`. All these files and parent directories must be root-owned and not writable by the application account. The release script deliberately uses its installed sibling health checker, not one supplied by the candidate release. Future changes to these installed control scripts require an explicit administrator update; merging the repository does not silently replace them.

Use a dedicated root-managed authorized-key file outside the writable application HOME, for example `/etc/ssh/authorized_keys/shutter-deploy`. Its one deployment key has `restrict,command="<fixed root-managed launcher>"`. A `Match User shutter-deploy` block must use only that key file, set `AuthorizedKeysCommand none` to disable any inherited cloud login helper, and force the same launcher, with `DisableForwarding yes`, `PermitTTY no`, `PermitUserRC no`, `AuthenticationMethods publickey`, `PasswordAuthentication no` and `KbdInteractiveAuthentication no`. Verify the installed OpenSSH version with `sshd -t` and effective `sshd -T -C ...` before reloading, preserving other users' access.

Install a verified same-version Node 22 binary as `/usr/local/libexec/shutter-count/receive-node`, root-owned and non-writable by the app. The receiver requires this dedicated interpreter and a system-only Git/tar PATH; the existing app/npm/PM2 runtime remains separate and must be non-writable by the deployment account. Its verified interpreter is preserved on restart.

The launcher must invoke that fixed `receive-node` interpreter/receiver with a clean environment and preserve only the untrusted `SSH_ORIGINAL_COMMAND` string for strict parsing. It must not evaluate or concatenate that string into shell code. Inspect `AcceptEnv`, `PermitUserEnvironment` and the account's login shell/startup files: a writable `.bashrc`, `BASH_ENV` or similar startup hook must not run before the forced entrypoint. `restrict` alone is not a shell-startup sandbox. The account must be unable to add an alternative authorized key or edit the launcher/configuration.

Exercise rejection cases before enabling: interactive shell, SFTP/SCP, forwarding/TTY, malformed input, a non-main SHA, another repository/run, failed tests and stale attempts. Confirm valid input runs as the dedicated UID and cannot use sudo. Test an actual release and health-triggered rollback with this account/PM2 service; mock unit tests do not establish these host guarantees.

## GitHub setup and the one private-key handoff

Persistent access must be explicitly approved. The operator generates a dedicated Shutter deployment key in a trusted environment and personally enters the private key into GitHub's secure **production environment secret** UI as `SHUTTER_DEPLOY_SSH_KEY`. Do not put the private key in chat, a repository, issue, log or artifact. An assistant may install the matching public key after approval, but must not read or relay the private key. Rotate/revoke by removing the old server public-key entry and replacing the environment secret through the same secure process.

Configure `production` with a **selected branch** rule matching only `main`, and no tag rule. Protect main/workflow changes with appropriate review and required CI; YAML alone does not configure those protections. Environment reviewers can be added when each deployment should require approval; unattended deployment requires the operator's approval.

Repository variable:

| Name | Value |
| --- | --- |
| `SHUTTER_DEPLOY_ENABLED` | Leave unset until verified; finally `true` |

Production environment variables:

| Name | Value |
| --- | --- |
| `SHUTTER_DEPLOY_HOST` | Verified SSH DNS name or IPv4 address |
| `SHUTTER_DEPLOY_PORT` | Verified SSH port; blank means 22 |
| `SHUTTER_DEPLOY_KNOWN_HOSTS` | Trusted host public-key entry; `[host]:port` for a non-default port |
| `SHUTTER_DEPLOY_PUBLIC_URL` | `https://rende.fun/shutter` |

Only one environment secret is required: `SHUTTER_DEPLOY_SSH_KEY`. Obtain the server public host key/fingerprint through an already trusted console such as Workbench, then pin the exact known-hosts entry. Blindly trusting a fresh `ssh-keyscan` result is not verification. The client requires strict host-key checking, uses a temporary mode-0600 key file, removes key material from the SSH child environment and cleans temporary files. No third-party SSH action or SSH agent is used.

The workflow has `contents: read`, pinned official checkout/setup actions, no persisted checkout credentials and no OIDC permission. PR jobs never receive production secrets. The deployment job has `needs: test` and only permits main `push`/manual runs. Server-side validation is additional protection, not a substitute for reviewing main and workflow changes.

## Verify and recover

1. Review/test the PR and install the reviewed receiver/launcher with the administrator.
2. Verify the restricted identity, stable PM2 boot paths and trusted host key; have the operator enter the private-key secret securely.
3. Enable `SHUTTER_DEPLOY_ENABLED=true`; run the workflow on main and check the exact SHA's test/deploy jobs plus both health URLs. A skipped deployment is not a release.
4. Verify the next merge deploys successfully before relying on unattended operation.

The final runner-side public check can fail even after the server completed successfully. It reports failure without launching a second racing rollback. Inspect the current revision, routing, TLS and runner connectivity before retrying. Do not infer failure means production reverted.

Server release output is retained in `/opt/shutter-count/deploy-<release-id>.log` without relaying it to the runner. When retrying CI, rerun the full workflow so the same attempt contains a successful test job. A failed activation logs rollback to `/opt/shutter-count/rollback-<release-id>.log`. If it reports `CRITICAL`, inspect current, PM2 and health before another release. Disconnect/HUP/TERM recovery is tested, but SIGKILL, power loss or storage failure can prevent rollback. Keep previous versions until validated; no automatic pruning is performed. Disable future releases by setting `SHUTTER_DEPLOY_ENABLED=false`; this does not cancel an already running server deployment.

## Security boundary

A forced command constrains the SSH entrypoint. It is not a sandbox for trusted main code: dependency hooks, tests and the deployed app run with the full `shutter-deploy` account permissions. Review main changes accordingly. A compromised deployment key can trigger permitted deployments and application-level disruption; it does not intentionally grant root/sudo. Unix accounts on one ECS still share a kernel/resources and are not absolute isolation. An ECS instance role, if added later, needs a separate metadata-access review. No instance-wide cloud role is created by this design.

References: [OpenSSH authorized keys](https://man.openbsd.org/sshd.8#AUTHORIZED_KEYS_FILE_FORMAT), [server restrictions](https://man.openbsd.org/sshd_config.5), [host-key verification](https://man.openbsd.org/ssh-keyscan.1), [GitHub environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments), [GitHub concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).
