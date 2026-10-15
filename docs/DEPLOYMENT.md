# Deployment

[English](DEPLOYMENT.md) | [简体中文](DEPLOYMENT.zh-CN.md)

Automatic deployment uses the shared workflow in [rendeyuwei/rende-deploy](https://github.com/rendeyuwei/rende-deploy). Read that repository's README and `.github/workflows/deploy-project.yml` on `main` before changing the caller or the host.

## GitHub Actions

[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) runs on a push to `main` and on `workflow_dispatch`. It calls:

```yaml
uses: rendeyuwei/rende-deploy/.github/workflows/deploy-project.yml@main
```

with `project: shutter`. The shared workflow installs dependencies, runs this repository's test command, then opens SSH and sends only:

```text
deploy shutter <40-hex-sha>
```

The deploy job waits for that test job. A successful test on `main` always deploys. Concurrency uses `cancel-in-progress: false`, so a newer push waits for the deployment already in progress.

The ECS compiles with the `build` line in `/etc/rende-deploy/projects/shutter.conf`. Changing the runner `test_command` leaves that server command as it is.

Pull requests run [`.github/workflows/ci.yml`](../.github/workflows/ci.yml). That workflow repeats the same checks and does not receive deploy secrets.

Repository secrets, the same four values used by the other rende.fun callers:

| Secret | Value |
| --- | --- |
| `ECS_HOST` | ECS host or IP, checked against the console |
| `ECS_USER` | `rende-deploy` |
| `ECS_SSH_KEY` | Private key for that user; the same key as rende-site |
| `ECS_KNOWN_HOSTS` | Host key line compared with the console, not a blind `ssh-keyscan` |

`ECS_USER` must be `rende-deploy` before this workflow is merged. Store the private key only in GitHub's secret UI.

## Host

Project id `shutter` is `/etc/rende-deploy/projects/shutter.conf` on the ECS. The tree is `/opt/shutter-count`, the PM2 app name is `shutter-count`, and the receiver's health check is `http://127.0.0.1:3020/shutter`. After SSH succeeds, the runner also requests `https://rende.fun/shutter/`. The path without the trailing slash answers 308, and the runner does not follow redirects. Installing the receiver, the forced command, and the project config is documented in rende-deploy. Merging this repository does not update `/usr/local/libexec/`.

`/opt/shutter-count` has to be writable by `rende-deploy`. Ownership may need to move from `shutter-deploy` to `rende-deploy` before the first shared deploy. The PM2 process must use `/opt/shutter-count/current` so a restart follows the symlink. Keep PM2 `kill_timeout` at `25000` so the application's 20-second shutdown can finish.

## Layout

These settings describe the intended `rende.fun` layout. They do not prove what is running.

- Runtime: Node.js 22, on the `PATH` configured for `shutter` in rende-deploy (`/opt/node-v22.23.2-linux-x64/bin` on this host).
- Releases: `/opt/shutter-count/releases/<id>/`, with `/opt/shutter-count/current` pointing at the active release.
- Process manager: PM2 app `shutter-count`.
- Bind address: `127.0.0.1:3020`.
- Public URL: `https://rende.fun/shutter`.
- Reverse proxy: the host nginx snippet for `/shutter` stays outside this repository. Ordinary releases do not edit nginx.
