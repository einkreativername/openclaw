# docker-buildx-with-cache

Wraps `docker buildx build` with `--cache-from` / `--cache-to` flags
pointing at GHCR. Pushes the cache only on `main` runs; restores on
every Docker build job.

## Inputs

| Name | Required | Default | Description |
|---|---|---|---|
| `image` | yes | — | Image:tag to build. |
| `context` | no | `.` | Build context path. |
| `dockerfile` | no | `Dockerfile` | Dockerfile path relative to context. |
| `push-cache` | no | `auto` | `auto` pushes only on `main`; `true` forces; `false` never. |
| `cache-namespace` | no | `buildcache` | GHCR tag prefix for the cache image. |
| `target` | no | — | Optional `--target` stage. |
| `progress` | no | `auto` | docker buildx `--progress` flag (`auto`, `plain`, `tty`, etc.). |
| `build-args` | no | — | Extra `--build-arg` flags, one per line. |

## Outputs

| Name | Description |
|---|---|
| `image` | Echoes the input `image:tag`. |

## Usage

```yaml
- uses: actions/checkout@v4
- uses: ./.github/actions/docker-buildx-with-cache
  with:
    image: openclaw:test
    progress: plain
    build-args: |
      --build-arg OPENCLAW_EXTENSIONS=matrix
      --build-arg OPENCLAW_DOCKER_BUILD_SKIP_DTS=1
```

## Cache namespace

By default the cache lives at `ghcr.io/<repo-owner>/buildcache:branch-main`.
This is intentionally separate from the actual published `openclaw/openclaw:*`
images. Set `cache-namespace: <other>` to use a different namespace.

## Auth

The action uses the auto-attached `GITHUB_TOKEN` via `docker/login-action`
ONLY when `push-cache` resolves to `true`. Public GHCR images can be
pulled anonymously, so PR builds that only restore need no login.
