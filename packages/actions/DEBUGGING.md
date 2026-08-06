# Debugging

This project has two debugging setups depending on what you're working on:

1. **Unit-level logic** — debug directly with `vitest` on your host machine. Fast, no Docker involved.
2. **Full workflow / action-in-context** — debug through `act`, using real project context from the test project instead of mocked inputs. Slower and more moving parts, but you get the actual environment.

Prefer (1) whenever possible. Reach for (2) when you specifically need the real test-project context that would otherwise require a lot of mock/dummy data to reproduce.

---

## 1. Debugging with vitest (no Docker)

### Without an IDE

```bash
vitest --inspect-brk --no-file-parallelism
```

- `--inspect-brk` pauses at the first line and waits for a debugger to attach.
- `--no-file-parallelism` keeps everything in a single process/worker so the debugger doesn't lose track of which worker to attach to.

Once you see `Debugger listening on ws://127.0.0.1:9229/...`, open `chrome://inspect` in Chrome and click **inspect** on the target.

To target a single test file:

```bash
vitest --inspect-brk --no-file-parallelism run path/to/your.test.ts
```

### With VS Code

**Quickest:** open a **JavaScript Debug Terminal** (Cmd+Shift+P → "Debug: JavaScript Debug Terminal") and just run `vitest` or `npm test` inside it. VS Code auto-attaches to any Node process spawned from that terminal — no flags needed.

**Reusable launch config** (`.vscode/launch.json`):

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "launch",
      "name": "Debug Current Test File",
      "autoAttachChildProcesses": true,
      "skipFiles": ["<node_internals>/**", "**/node_modules/**"],
      "program": "${workspaceRoot}/node_modules/vitest/vitest.mjs",
      "args": ["run", "${relativeFile}"],
      "smartStep": true,
      "console": "integratedTerminal"
    }
  ]
}
```

Open the test file, hit F5, breakpoints set in the gutter will bind.

**Tip:** bump `testTimeout` while debugging so vitest doesn't kill a test for sitting at a breakpoint too long.

---

## 2. Debugging through `act`

### Why this is more involved than it sounds

- **`act` does not support publishing container ports to the host.** This is an open, unimplemented feature request ([nektos/act#569](https://github.com/nektos/act/issues/569)). `--container-options "-p ..."` silently does nothing — don't waste time on it.
- **`act`'s job containers run in Docker's `--network host` mode**, whether or not the workflow uses a `container:` block (a `container:` block just adds a *second*, nested host-network container on top).
- **On Docker Desktop for macOS, `--network host` does not mean your Mac** — it means the internal LinuxKit VM's own network namespace, which is not reachable from macOS at all by default.
- Docker Desktop's experimental "host networking" setting (Settings → Resources → Network) is *supposed* to bridge this, but is currently unstable and can crash Docker Desktop entirely (`com.docker.virtualization: process terminated unexpectedly: use of closed network connection` — a known, currently open Docker Desktop bug).

Net effect: there is no way to open an inbound connection from your Mac into the debug port. The workaround exploits the fact that **outbound** connections from the container work completely normally, host-network or not.

### The fix: SSH reverse tunnel

Instead of connecting *into* the container, have a process *inside* the container connect *out* to your Mac and ask it to forward a port back.

#### One-time setup

1. **Enable Remote Login** on your Mac: System Settings → General → Sharing → Remote Login (starts local `sshd`).
2. **Generate a dedicated key and authorize it:**
   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/act_debug_key -N ""
   cat ~/.ssh/act_debug_key.pub >> ~/.ssh/authorized_keys
   ```
3. Confirm the `act` runner image has an SSH client (`catthehacker/ubuntu:act-latest` does by default):
   ```bash
   docker exec <container_id> which ssh
   ```

#### Workflow setup

Keep a local-only workflow variant (outside `.github/workflows/`, so GitHub never picks it up) that mirrors the real workflow but:

- **Does not use `container:`** — this avoids the nested host-network container and lets you use the target image directly as the runner image instead:
  ```bash
  act pull_request \
    -W .github/act-tests/validate-pr.yml \
    --eventpath .github/act/pull_request.json \
    -j validate \
    -P ubuntu-latest=ghcr.io/your-org/your-image:latest \
    --container-options "-v /local/path/to/project:/path/in/container/.project-actions"
  ```
  Any bind mounts previously declared under `container: options:` need to move to `--container-options` on the CLI, since that config lived on the `container:` block.

- **Sets `NODE_OPTIONS` only on the step you want to debug**, not job-wide — otherwise the first Node process spawned by any earlier step (e.g. `pnpm install`, `turbo build`) grabs the debug port and blocks everything after it:
  ```yaml
  - name: Validate PR
    id: validate
    env:
      NODE_OPTIONS: --inspect-brk=0.0.0.0:9229
    uses: ./.project-actions/packages/actions/validate-pr
    with:
      packages: type-factory
  ```

#### Each debug session

1. Run `act` as above and let it reach the debug step. Watch for:
   ```
   Debugger listening on ws://0.0.0.0:9229/...
   ```
2. Find the running container:
   ```bash
   docker ps
   ```
3. Copy the key in and start the reverse tunnel:
   ```bash
   docker cp ~/.ssh/act_debug_key <container_id>:/tmp/act_debug_key
   docker exec <container_id> chmod 600 /tmp/act_debug_key
   docker exec -d <container_id> \
     ssh -N -o StrictHostKeyChecking=no -i /tmp/act_debug_key \
     -R 9229:localhost:9229 \
     "$(whoami)@host.docker.internal"
   ```
   This runs `ssh` *inside* the container (same network namespace as the paused Node process, so its `localhost:9229` is the real inspector) and asks your Mac's `sshd` to open `9229` locally and tunnel anything that arrives there back to the container. Purely outbound from the container's side — the host-network inbound restriction never comes into play.
4. Verify:
   ```bash
   curl http://localhost:9229/json/list
   ```
   Should return JSON describing the paused script.
5. Attach your IDE / Chrome DevTools at `localhost:9229`.
6. When done:
   ```bash
   docker exec <container_id> pkill ssh
   ```

#### Automating it (container ID changes every run)

```bash
#!/usr/bin/env bash
set -euo pipefail

LOG=/tmp/act-debug.log
act pull_request \
  -W .github/act-tests/validate-pr.yml \
  --eventpath .github/act/pull_request.json \
  -j validate > "$LOG" 2>&1 &
ACT_PID=$!

echo "Waiting for job container..."
CID=""
while [ -z "$CID" ]; do
  CID=$(docker ps --filter "name=act-SFPM-Actions-Test" --format '{{.ID}}' | head -n1)
  sleep 1
done
echo "Container: $CID"

echo "Waiting for inspector..."
until grep -q "Debugger listening" "$LOG"; do sleep 1; done

docker cp ~/.ssh/act_debug_key "$CID":/tmp/act_debug_key
docker exec "$CID" chmod 600 /tmp/act_debug_key
docker exec -d "$CID" \
  ssh -N -o StrictHostKeyChecking=no -i /tmp/act_debug_key \
  -R 9229:localhost:9229 "$(whoami)@host.docker.internal"

echo "Tunnel ready — attach on localhost:9229"
wait "$ACT_PID"
```

Adjust the `docker ps --filter name=...` pattern if your job/workflow name changes — `act` names containers after the workflow and job name, and the filter needs to match a stable prefix of that.

### Getting breakpoints to actually bind (source maps)

Attaching successfully doesn't mean editor breakpoints will hit — that also requires the debug adapter to map your TypeScript source to the right location in the running (possibly bundled) JS, via source maps plus a path translation between the container and your machine.

**Quick sanity check:** put a literal `debugger;` statement in the code before rebuilding. V8 always honors this regardless of source-map/path config — if this stops but your editor breakpoints don't, it's a mapping problem, not a connection problem.

**To fix the mapping:**

1. Confirm source maps are actually being built and shipped:
   ```bash
   docker exec <container_id> ls -la /path/to/dist/
   docker exec <container_id> tail -c 200 /path/to/dist/validate-main.js
   ```
   You want a `.js.map` file next to the bundle, and a `//# sourceMappingURL=...` comment at the end of the JS.

2. Check what path the source map thinks the original files live at:
   ```bash
   docker exec <container_id> cat /path/to/dist/validate-main.js.map | head -c 500
   ```
   Look at the `"sources"` field.

3. Set `localRoot`/`remoteRoot` in your VS Code attach config to bridge the container's checkout path and your actual disk path. In our case, because the action's source is bind-mounted in via:
   ```
   -v /local/path/to/sfpm:/path/in/container/.project-actions
   ```
   the mapping needs to point at that specific mounted path, not just `${workspaceFolder}` — the code being debugged lives in a different (mounted-in) repo than the one containing the workflow itself:

   ```json
   {
     "type": "node",
     "request": "attach",
     "name": "Attach to act",
     "port": 9229,
     "localRoot": "/local/path/to/sfpm",
     "remoteRoot": "/path/in/container/.project-actions",
     "sourceMaps": true,
     "skipFiles": ["<node_internals>/**"]
   }
   ```

---

## Why not just fix `act`'s networking?

Several things were tried and ruled out along the way, in case they come up again:

- **`--container-options "-p ..."`** — no-op, act doesn't implement port publishing at all ([nektos/act#569](https://github.com/nektos/act/issues/569)).
- **`--container-options "--network bridge"`** — act hard-codes host networking for job containers; this override isn't respected.
- **A socat proxy connecting via `host.docker.internal`** — wrong direction. `host.docker.internal` lets a container reach the Mac, not the other way around, and it doesn't route into the VM's host-mode namespace at all.
- **A socat sidecar on the same Docker network as the job container** — doesn't apply here, since the job container isn't on a normal bridge network to begin with; it's on `host`.
- **Docker Desktop's "Enable host networking" setting** — would solve this cleanly in theory, but is currently unstable enough to crash the whole Docker Desktop backend. Worth periodically retrying as Docker Desktop ships updates; the SSH tunnel is the reliable fallback until then.