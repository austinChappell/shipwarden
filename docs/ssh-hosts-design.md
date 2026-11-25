# Design: remote worktrees on SSH hosts

Plan item 2.4. Status: draft for review. This document has no code. Each phase in "Phased delivery" is a separate pull
request.

## 1. Summary

A repository can live on an SSH host, for example a large Linux server. ShipWarden copies a small runtime to the host.
The runtime runs the terminals, the agent hooks, git, the file access, and the language servers on the host. The app
on the Mac talks to the runtime through one SSH connection. The runtime uses the JSON-RPC protocol of the PTY host
today, with more methods.

The main decisions:

- The runtime is a single-file Node bundle, a pinned Node binary, and a node-pty addon that ShipWarden builds for Linux
  x64 and arm64. The host needs no Node, no npm, and no compiler.
- The app uses the system `ssh` with a ControlMaster. It reads `~/.ssh/config`, the SSH agent, and the known hosts as
  the user's own `ssh` does. ShipWarden adds no SSH library.
- The app and the runtime talk through the stdin and stdout of one `ssh` command. Nothing listens on a TCP port, on
  the host or on the Mac.
- On Linux, a transient systemd user unit keeps the runtime alive. A `setsid` process is the fallback.
- A `WorkspaceHost` interface hides the place of a worktree. The local code implements it with the classes of today.
  The SSH code implements it with a JSON-RPC proxy to the same classes on the host.
- Agents on the host reach the MCP server and the `shipwarden` CLI through stdio shims and Unix sockets of the runtime.
  The runtime sends the calls to the app.
- The first useful slice is terminal-only remote worktrees: create a worktree on the host, run agents in it, and see
  their state.

## 2. Goals, non-goals, and user stories

### Goals

- Run agents in git worktrees on a Linux machine with more CPU, memory, or disk than the Mac.
- Keep the agents alive when the Mac sleeps, the link drops, or the app quits.
- Show remote worktrees in the same sidebar, tabs, and views as local worktrees. A remote worktree has a host badge.
- Use the SSH setup that the user has today: keys, the SSH agent, `~/.ssh/config` (with `ProxyJump`), and the known
  hosts.
- Install nothing as root. Open no port on the host.

### Non-goals (for this plan item)

- macOS or Windows hosts. A macOS host can reuse the launchd code later.
- Hosts with musl (Alpine) or a glibc older than 2.28 (for example CentOS 7).
- A shared host where more users share one ShipWarden runtime. Each SSH user gets a separate runtime.
- Copy of the user's agent logins, API keys, or GitHub token from the Mac to the host.
- Sync of a local worktree to a remote worktree. A repository is local or remote, not both.
- Cloud VMs that ShipWarden makes itself. That is the "Cloud worktrees" idea of the plan, after 2.4.
- A password store in ShipWarden. The user types a password or a one-time code in a terminal tab (see "Authentication and known hosts" in section 5).

### User stories

1. As a user with a Linux build server, I add the host `build-1` from my `~/.ssh/config` in Settings › Hosts.
   ShipWarden checks the host and shows "Ready".
2. I add the repository `/home/me/src/api` on `build-1` to a project. The sidebar shows it with a host badge.
3. I start a Claude Code agent in a new worktree of that repository. The worktree is on the host. The agent runs on the
   host, and its tab shows "Agent is working".
4. I close the laptop and go home. The agent continues to work. When I open the laptop, the tab connects again and
   shows the output that I did not see.
5. The agent asks for a permission. The tab shows "Waiting for approval", as for a local agent.
6. I open the Changes tab of the remote worktree, read the diff, and commit. (Phase 2.)
7. I open a file in the editor, change it, and use go to definition. (Phases 3 and 4.)
8. The agent calls the ShipWarden MCP tool `get_task`. The tool works, as for a local agent. (Phase 5.)

## 3. The code today

This section lists the facts that the design builds on.

### PTY host (`src/main/pty-host/`)

- `main.ts` is a separate bundle entry (`pty-host` in `electron.vite.config.ts`). Electron runs it as Node with
  `ELECTRON_RUN_AS_NODE=1`.
- `PtyHostServer` listens on a Unix socket (mode 0600) and speaks JSON-RPC with `vscode-jsonrpc`
  (`SocketMessageReader` and `SocketMessageWriter`). Methods: `hello`, `create`, `list`, `replay`, `kill`,
  `killWorktree`, `shutdown`, `write`, and `resize`. Events: `data` (with a sequence number), `exit`, and `agentState`.
- `PTY_HOST_PROTOCOL` and a `buildId` (a hash of the host script) version the host. Each build has its own socket. An
  outdated host keeps its running sessions, gets no new sessions, and stops when it has no running sessions.
- The host stops after 10 seconds with no app and no running session (`checkIdle`).
- `TerminalManager` runs `node-pty`. `OutputBuffer` keeps the last 1 MiB of each session, so `replay` can send it again.
- `host-launch.ts` starts the host through a launchd job, so a force quit of the app does not stop it. This is macOS
  only.
- The PTY host also runs the agent `HookServer` on a second Unix socket (`.hook`).

### Background helper (`src/main/helper/`)

- `helper/main.ts` is a second bundle entry. A launch agent (`launch-agent.ts`, `helperPlist`) starts it at login.
- `headless-agents.ts` (PR #257) already has small interfaces for the services that it uses: `HelperTerminals` (the
  shape of `PtyHostClient`) and `HelperWorktrees` (the shape of `GitWorktreeService`). These interfaces are the model
  for `WorkspaceHost`.

### Worktrees, git, and files

- `GitWorktreeService` (`worktrees/git-worktree-service.ts`, 650 lines) has one private `git()` runner with
  `execFile('git', …)`, plus `fs.stat`, `fs.access`, and `fs.realpath`.
- `GitChangesService` (`git/git-changes-service.ts`, 852 lines) has one `spawn('git', …)` runner and about 30 public
  methods. Each method takes the worktree path as its first argument.
- `git/checkpoints.ts` has free functions with their own `spawn('git', …)` runner.
- `FileService` (`files/file-service.ts`) uses `fs` and `git grep`. `FileWatcher` uses a recursive `fs.watch`.
  `createFileProtocolHandler` serves media files to the `shipwarden-file:` protocol.
- All of these classes take paths as arguments and use no Electron API. They can run in a plain Node process.

### LSP (`src/main/lsp/`)

- `LspManager` starts each language server with `spawn` and stdio, and speaks JSON-RPC with
  `StreamMessageReader` and `StreamMessageWriter`. It forwards some notifications to the page.
- `ServerInstaller` installs rust-analyzer, basedpyright, and gopls into a folder of the app.

### Agent hooks (`src/main/agents/`)

- `HookServer` listens only on a Unix socket, with a random token. The comment in the file explains why: security
  tools read plain HTTP on 127.0.0.1.
- The hook commands (`src/shared/agents.ts`) run `curl --unix-socket "$SHIPWARDEN_HOOK_SOCKET"`. So the host needs
  `curl`.
- `writeAgentHookFiles` writes the Claude Code, Codex, Gemini CLI, and opencode hook files, and the zsh and bash
  integration. It uses only `fs`.

### MCP server (`src/main/mcp/`)

- `McpHttpServer` uses the Streamable HTTP transport on `127.0.0.1`. `McpTokens` gives each agent session a token that
  identifies its worktree. The token file keeps only hashes.
- The MCP config file of a session is in the app data folder on the Mac. An agent on the host cannot read it, and it
  cannot reach `127.0.0.1` of the Mac.

### CLI (`src/main/cli/`, PR #256)

- `CliServer` reads one JSON line from a Unix socket (mode 0600) and checks a token. `CliHost` writes the socket path
  and the token to `~/.shipwarden/cli.json`.
- `CliServer` and `CliActions` use no Electron API.

### How many call sites move

A rough count with grep in `src/main` (files without tests):

| Area | Count |
|---|---|
| Files that import `child_process` | 38 |
| Files that import `fs` | 64 |
| Files that run `git` with `execFile` or `spawn` | 13 |
| Calls to `gitChanges.*` from IPC, services, MCP, CLI, review, compare, plans, PR groups, automations, and remote | 27 |
| Calls to `worktrees.*` from the same folders | 31 |
| Calls to `terminals.*` | 25 |
| Calls to `files.*` and `fileWatcher.*` | 16 |
| Calls to `lsp.*` | 7 |
| Calls to the checkpoint functions | 3 |

So about **110 call sites** must go through `WorkspaceHost`. Most `fs` users (stores for settings, tasks, notes, and
automations) stay local and do not move. The 13 files that run `git` are the worktree, changes, checkpoint, file,
review checkout, and project services, plus five review providers that read the remote URL. Each of them moves behind
`WorkspaceHost` or gets its git output from it.

## 4. The runtime on the host

### What it contains

The runtime is one new bundle entry, `src/main/host-runtime/main.ts`. It imports the code of today and runs it on the
host:

| Part | Code that it reuses |
|---|---|
| Terminals | `TerminalManager`, `OutputBuffer` |
| Agent hooks | `HookServer`, `agentStateFromHook`, `writeAgentHookFiles`, shell integration |
| Worktrees | `GitWorktreeService` |
| Git changes and checkpoints | `GitChangesService`, `git/checkpoints.ts` |
| Files | `FileService`, `FileWatcher`, a range read for media files |
| LSP proxy | The `spawn` and stdio part of `LspManager`, and `ServerInstaller` |
| MCP and CLI relay | New: a Unix socket for the stdio shims, see section 7 |

The runtime has three commands:

- `swr daemon <socket>`: the long-lived process. It is the PTY host server with more methods.
- `swr connect <socket>`: a bridge. It connects to the daemon socket and copies bytes between the socket and its own
  stdin and stdout. When no daemon listens, it starts one first. The app runs this command through SSH.
- `swr mcp` and `swr cli`: the stdio shims for agents (section 7).

### How ShipWarden packs it

Options:

| Option | For | Against |
|---|---|---|
| A. Use the Node of the host | Small upload | Many servers have no Node, or an old Node. node-pty needs a compiler and Python on the host. |
| B. Node single executable application (SEA) | One file | node-pty is a native addon. SEA cannot load it from the blob, so a second file is still necessary. The SEA build is experimental. |
| **C. A pinned Node binary, the bundle, and a prebuilt node-pty** | No compiler and no Node on the host. The same Node version everywhere. | About 30 MB to upload one time per Node version |

**Decision: option C.** The package for each architecture is a `.tar.gz` file with this content:

```text
shipwarden-runtime-<version>-linux-<arch>/
  bin/node              Node 24 LTS, the official linux-<arch> binary
  bin/swr               a sh script: exec "$(dirname "$0")/node" "$(dirname "$0")/../runtime.js" "$@"
  runtime.js            the bundle (vscode-jsonrpc and the shared code inside)
  node_modules/node-pty/  lib/ and build/Release/pty.node for this arch
  manifest.json         version, buildId, Node version, protocol, SHA-256 of each file
```

node-pty 1.1 has prebuilds only for macOS and Windows (`node_modules/node-pty/prebuilds` has `darwin-*` and
`win32-*`). So a CI job builds `pty.node` for Linux:

- It runs in a container with glibc 2.28 (for example `almalinux:8`), so the addon loads on Debian 10, Ubuntu 20.04,
  RHEL 8, and newer.
- It builds against the headers of the pinned Node version (`node-gyp rebuild --target=<version>`).
- It runs on `ubuntu-24.04` for x64 and on `ubuntu-24.04-arm` for arm64. Both are GitHub hosted runners, so no
  emulation is necessary.
- The job also runs a smoke test: it starts `node -e "require('node-pty').spawn('sh', ['-c', 'echo ok'])"`.

The Release workflow attaches the two packages to the GitHub release, with their SHA-256 in `shipwarden-update.json`.

### How the app gets it

- The DMG does not contain the packages. They add about 60 MB, and most users never add a host.
- When the user adds the first host of an architecture, the app downloads the package of its own version from the
  GitHub release. The download uses the CA certificates of Settings › Network (`TrustedCertificates`), because a work
  VPN can inspect TLS. The app checks the SHA-256 and keeps the package in `<app data>/host-runtime/`.
- A development build (`npm run dev`) builds the bundle locally and uses a node-pty addon from a local cache. See
  "Open questions".
- The host downloads nothing. Many build servers cannot reach GitHub, but SSH from the Mac always works.

### Where it lives on the host

```text
~/.shipwarden/host/
  node/<node version>/bin/node           shared by the builds with the same Node version
  runtime/<buildId>/                     runtime.js, bin/swr, node_modules/node-pty
  run/                                   sockets (mode 0700 folder)
    runtime-v<protocol>-<buildId>.sock
    runtime-v<protocol>-<buildId>.hook
    relay-<buildId>.sock                 MCP and CLI shims
  agents/                                hook files and shell integration of the runtime
  logs/runtime-<buildId>.log
~/.shipwarden/worktrees/                 the default worktree folder, as on the Mac
```

Linux accepts a socket path of at most 108 bytes. When `~/.shipwarden/host/run` makes a path too long, the runtime uses
`/tmp/sw-<uid>-<hash>/` with mode 0700. This is the same rule as `ptyHostSocketFolder`. The runtime does not use
`$XDG_RUNTIME_DIR`, because systemd removes that folder when the last session of the user ends without linger.

### Versions and upgrades

- `REMOTE_PROTOCOL` is a number, as `PTY_HOST_PROTOCOL`. The `buildId` is the SHA-256 of `runtime.js` and `pty.node`.
- The install is idempotent:
  1. The app runs `cat ~/.shipwarden/host/runtime/<buildId>/manifest.json`. If the file is there and the hashes
     match, the install is done.
  2. If not, the app sends the package through `ssh host 'mkdir -p … && tar -xzf - -C <tmp>'`, checks the hashes on the
     host with `sha256sum`, and renames the temporary folder to `<buildId>`. The rename makes the install atomic.
- An upgrade follows the PTY host rule. A new app connects to the runtime of its own build. A runtime of an older build
  keeps its running sessions, and the app shows them with `hostOutdated`. It stops when it has no running session.
- The app removes the folders of old builds when no daemon of that build runs and the folder is older than 14 days.

## 5. Transport

### The SSH connection

Options:

| Option | For | Against |
|---|---|---|
| **A. The system `ssh` with ControlMaster** | It reads `~/.ssh/config`, `ProxyJump`, `Match`, the SSH agent, hardware keys, Kerberos, and `known_hosts`. One login serves many channels. No new dependency. | ShipWarden must parse the errors of a process. The ControlMaster socket path has a length limit. |
| B. An SSH library (`ssh2`) | Full control of channels and errors | A new dependency. ShipWarden must read `~/.ssh/config`, `ProxyJump`, and the agent itself, and it cannot match the user's `ssh` in all cases. |

**Decision: option A.** The app runs `/usr/bin/ssh` with these options, after the user's own config:

```text
ssh -o ControlMaster=auto
    -o ControlPath=<app data>/ssh/%C        (%C is a hash, so the path stays short)
    -o ControlPersist=10m
    -o ServerAliveInterval=15 -o ServerAliveCountMax=3
    -o BatchMode=yes
    -T <host alias> <command>
```

- `BatchMode=yes` stops each prompt for a password, a passphrase, or an unknown host key. The app never types into
  `ssh`. "Authentication and known hosts" tells what happens when a prompt is necessary.
- The user's `~/.ssh/config` stays the source of truth. ShipWarden does not write to it.
- One ControlMaster serves the main channel, the uploads, and the short commands (preflight, install). So a host with a
  second factor asks for it one time, not one time per channel.

### Stdio framing, not port forwarding

Options:

| Option | For | Against |
|---|---|---|
| **A. JSON-RPC on the stdin and stdout of `ssh host swr connect`** | Works when the admin turns off forwarding (`AllowTcpForwarding no`, `AllowStreamLocalForwarding no`). No socket file on the Mac. One process to watch. | All traffic shares one channel. |
| B. `ssh -L <local socket>:<remote socket>` | The app connects to a local socket, as for the PTY host today. | The server can forbid it. A stale socket file stays after a crash. |

**Decision: option A.** `vscode-jsonrpc` has `StreamMessageReader` and `StreamMessageWriter`, which frame messages
with `Content-Length` headers on any stream. `LspManager` already uses them. The `connect` bridge copies raw bytes,
so the daemon sees the same socket protocol as a local PTY host.

Large transfers (the runtime package, files that the user drops in, a large file read) use a second, short `ssh`
command on the same ControlMaster. So they do not block terminal output.

### Reuse of the PTY host protocol

`PtyHostServer` and `PtyHostClient` speak the same methods over a Unix socket today. The runtime keeps these methods
without change and adds new groups with a prefix:

| Group | Methods (examples) |
|---|---|
| (none) | `hello`, `create`, `list`, `replay`, `kill`, `killWorktree`, `shutdown`, `write`, `resize` (today) |
| `worktrees/` | `list`, `create`, `remove`, `branches`, `copyIgnored`, … (the `GitWorktreeService` methods) |
| `git/` | `status`, `contents`, `branchDiff`, `commit`, `push`, `rebase`, … (the `GitChangesService` methods) |
| `checkpoints/` | `create`, `list`, `previewRewind`, `rewind` |
| `files/` | `listDirectory`, `readFile`, `writeFile`, `searchContents`, `watch`, `unwatch`, `readRange`, … |
| `lsp/` | `start`, `send`, `stop`, and the event `lsp/message` |
| `relay/` | events from the runtime to the app: `mcp`, `cli` (section 7) |
| `exec/` | `run` for a short command with an allow list (for example `uname`, `git --version`) |

To change `PtyHostClient` as little as possible, the app makes a `MessageConnection` from the `ssh` streams and gives
it to the same `HostLink` code that a socket gives today. `PtyHostClient` gets a `connect()` option. Tests already
replace `spawnHost`, so this is a small change.

`hello` gets two more fields: `platform` (`linux-x64`) and `home` (the home folder on the host).

### Authentication and known hosts

- **Keys and the SSH agent**: `ssh` reads them as usual. The app runs `ssh` with the environment of the login shell
  (`loadLoginShellPath`), so `SSH_AUTH_SOCK` is the user's agent (also 1Password or Secretive).
- **`~/.ssh/config`**: the host list in Settings › Hosts reads the `Host` lines (without patterns) of
  `~/.ssh/config` and its `Include` files, as suggestions. The user can also type any alias or `user@host:port`.
- **Known hosts**: the app does not change `StrictHostKeyChecking`. With `BatchMode=yes`, an unknown or changed host
  key fails with "Host key verification failed". The app then shows the reason and the button "Connect in terminal".
- **Passwords and one-time codes**: when `BatchMode` fails with "Permission denied", the app shows "Connect in
  terminal" too.
- **Connect in terminal** opens a local terminal tab with `ssh -o ControlMaster=yes -o ControlPersist=10m … -N <host>`.
  The user accepts the host key or types the password or the code in that tab. When the master socket exists, the app
  continues with `BatchMode=yes` through it. The tab closes when the master is ready.
- **Agent forwarding** is off (`-o ForwardAgent=no`). A setting per host can turn it on, with a warning: root on the
  host can use the forwarded agent. Git on the host can need it for `git fetch` and `git push` over SSH.

### Reconnect

- The app watches the `ssh` process. When it exits, or when a `hello` ping (each 30 seconds) gets no answer in 10
  seconds, the link is down.
- The app tries again after 1, 2, 4, 8, 16, and then each 30 seconds. It tries at once after `powerMonitor` sends
  `resume` and when the network changes.
- `ServerAliveInterval=15` and `ServerAliveCountMax=3` let `ssh` find a dead link in about 45 seconds.
- After a reconnect, the app calls `list`, then `replay` for each open tab. `replay` returns the buffer and its last
  sequence number, so the tab drops the chunks that it already has. This is the same code as a window reload today.
- Each remote worktree, tab, and the host row show the state: "Connecting", "Connected", "Reconnecting", or
  "Offline". The tabs of an offline host keep their last screen and do not take input.

## 6. Keep the agents alive on Linux

launchd is macOS only. On the host, `swr connect` starts the daemon when no daemon listens. It tries these ways in
order:

1. **A transient systemd user unit.** It works when `systemctl --user is-system-running` answers, and
   `loginctl show-user "$USER" -p Linger` says `Linger=yes`:

   ```sh
   systemd-run --user --unit=shipwarden-runtime-<buildId> --collect \
     --property=KillMode=process --setenv=… ~/.shipwarden/host/runtime/<buildId>/bin/swr daemon <socket>
   ```

   The unit is not a process of the SSH session. So the end of the SSH session does not stop it. `KillMode=process`
   lets the terminal processes live when systemd stops the unit, as `AbandonProcessGroup` does on macOS. The unit
   writes no file, so nothing stays after a reboot.
2. **`setsid` and `nohup`.** When systemd has no user manager, or linger is off, the bridge starts
   `setsid nohup swr daemon <socket> >> <log> 2>&1 < /dev/null &`. The daemon is not in the session of the SSH login,
   so it gets no SIGHUP.
   - With logind `KillUserProcesses=yes` (the default on some distributions), the end of the last session stops this
     process. The preflight check reads the logind setting and warns: "Agents stop when you log out of the host. Run
     `loginctl enable-linger` on the host to keep them alive."

The app does not run `loginctl enable-linger` itself. The command changes the system state, and on some hosts it needs
the password. The preflight warning tells the user the command.

tmux is not necessary. The runtime already keeps the terminals and their output buffers, as the PTY host does on the
Mac. tmux adds a dependency and a second terminal emulator in the output path.

### When the Mac sleeps or the link drops

- The daemon and the agents continue to run. The output goes to the 1 MiB buffer of each session.
- Hook events continue to arrive at the hook server of the runtime. The runtime keeps the agent state of each session.
  The `list` answer after the reconnect has the last state, so a "Waiting for approval" from the night shows at once.
- A session that outputs more than 1 MiB while the Mac sleeps loses its oldest output. The tab shows the last 1 MiB.
  The same limit applies to a local session after a window reload.
- MCP and CLI calls from agents fail while no app is connected (section 7).
- The daemon stops only when no app is connected and no session runs, after the idle time of today (10 seconds).
- Notifications: the runtime cannot send a macOS notification. When the link comes back, the app compares the old and
  the new states and sends the notifications that it missed, once per session.

## 7. Agent hooks, MCP, and the CLI on the host

### Hooks

The hook server runs in the runtime, as in the PTY host today. Nothing changes for the agents:

- `writeAgentHookFiles` runs on the host at the daemon start, into `~/.shipwarden/host/agents/`.
- New sessions get `SHIPWARDEN_HOOK_SOCKET`, `SHIPWARDEN_HOOK_TOKEN`, and the shell integration variables with paths
  on the host.
- `curl --unix-socket` sends the events to the runtime. The runtime turns them into `agentState` events.
- The preflight check fails when the host has no `curl`, because no agent state shows without it.

### MCP

The MCP server stays in the app, because its tools use the app state (tasks, pull requests, the browser tab, and
approvals). An agent on the host cannot reach `127.0.0.1` of the Mac. A port on `127.0.0.1` of the host is not safe
either: on a shared host, each local user can connect to the loopback interface.

So the agent gets a **stdio MCP server** in place of the HTTP URL:

```json
{ "mcpServers": { "shipwarden": { "type": "stdio", "command": "~/.shipwarden/host/runtime/<buildId>/bin/swr",
  "args": ["mcp"], "env": { "SHIPWARDEN_MCP_TOKEN": "<token>" } } } }
```

(The app writes the full path, not `~`.)

1. `swr mcp` reads JSON-RPC lines on stdin and sends each message with the token to the relay socket of the runtime.
2. The runtime sends a `relay/mcp` request to the connected app.
3. The app gives the message to `McpHttpServer` with the token, as for an HTTP request, and sends the answer back.

Claude Code, Codex, Gemini CLI, and opencode all support stdio MCP servers. `McpTokens.issue` gets a `content`
function for the stdio form, and the runtime writes the session config file on the host (mode 0600). The token file on
the Mac keeps only the hash, as today. The worktree key of a token is the remote worktree ID (section 8).

When no app is connected, `swr mcp` answers each tool call with the error "ShipWarden is not connected to this host.
Try again later." A write tool that waits for an approval waits on the Mac, so the link must stay up during the wait.
If the link drops, the call fails with the same error.

### The `shipwarden` CLI

- The runtime writes `~/.shipwarden/cli.json` on the host with the path of its relay socket and a new token. It uses
  the same `CliConfig` shape, so the CLI code reads it without change.
- The `shipwarden` command on the host is `swr cli`. `shipwarden skill install` works on the host too.
- The runtime checks the token and sends the request as `relay/cli` to the app. `CliServer` in the app runs it with the
  same handler and approvals as a local request. The `cwd` of the request becomes a remote worktree ID.
- A host with its own ShipWarden app (for example a Mac host later) is a non-goal. The file name clash is a reason that
  macOS hosts wait.

### ask_agent and the other cross-worktree tools

These tools run in the app, so they work for remote worktrees after the call sites move to `WorkspaceHost`. They
read terminal output through `terminals.replay` and write through `terminals.write`, which work for both kinds.

## 8. The abstraction in the app

### Remote paths

Today a repository and a worktree are a path string. `Project.repos` is `string[]`. Paths are keys in many stores:
MCP tokens, task links, checkpoints, the branch summaries cache, and the page state.

A remote repository gets a URI with a fixed form:

```text
sw-ssh://<host id>/<absolute path on the host>
```

- `<host id>` is the ID of an entry in `<app data>/hosts.json` (alias, display name, architecture, settings). The ID
  does not change when the user edits the alias.
- A local path never starts with `sw-ssh://`, so all stores keep their string keys. Old data stays valid.
- A helper in `src/shared/workspace-path.ts` parses the URI: `{ host: 'local' | string, path: string }`.
- The page shows the path on the host and a host badge. The page never gives a `sw-ssh://` path to `path.join` of the
  Mac.

### The interface

```ts
/** The services of one machine that has worktrees. */
interface WorkspaceHost {
    readonly id: 'local' | string;
    readonly state: 'connected' | 'connecting' | 'offline';
    terminals: HostTerminals;      // the shape of PtyHostClient (HelperTerminals plus kill, resize, killWorktree)
    worktrees: Remote<GitWorktreeService>;
    changes: Remote<GitChangesService>;
    checkpoints: Remote<CheckpointApi>;
    files: Remote<FileService> & FileWatchApi;
    lsp: LspTransport;             // start a server and get a MessageConnection
}

/** All methods of T, with each result as a Promise. */
type Remote<T> = { [K in keyof T as T[K] extends (...args: never[]) => unknown ? K : never]: … };

interface WorkspaceHosts {
    /** Returns the host of a repository or worktree path, and the path on that host. */
    resolve(pathOrUri: string): { host: WorkspaceHost; path: string };
}
```

- `LocalWorkspaceHost` wraps the instances that `services.ts` makes today. It changes no behavior.
- `SshWorkspaceHost` makes a proxy for each group. A method call sends `<group>/<method>` with the arguments. The
  runtime has an allow list of the methods. It never calls a method name that it gets from the wire without that list.
- The runtime makes the same classes on the host and calls them. The two sides use one shared list of method names, so
  a test can check that the list matches the class methods.
- Results must be JSON. The current return types are plain objects, strings, and arrays, so this is true today. A unit
  test checks it for each method.

### The call sites that move

| From | To | Rough count |
|---|---|---|
| `gitChanges.<method>(wt, …)` in IPC, MCP, CLI, review, compare, plans, PR groups, automations, and remote | `hosts.resolve(wt).host.changes.<method>(path, …)` | 27 |
| `worktrees.<method>(repo, …)` | `….worktrees.<method>` | 31 |
| `terminals.<method>` | one `PtyHostClient` per host, behind a `TerminalRouter` that knows the host of each session ID | 25 |
| `files.*`, `fileWatcher.*` | `….files.*` | 16 |
| `lsp.*` | `LspManager` gets an `LspTransport` per host | 7 |
| checkpoint functions | `….checkpoints.*` | 3 |
| `execFile('git', …)` in project store, review checkouts, screenshots, and five review providers | `….changes` or a new `git/remoteUrl` method | 13 files |
| `shipwarden-file:` protocol handler | `files/readRange` for a remote root | 1 |
| Transcript readers (`transcript-reader`, `transcript-watcher`, `transcript-index`, token counter, pinned and recent sessions) | `files/readRange` and `files/watch` on the agent folders of the host | about 8 files, phase 5 |

Most changes are mechanical: one more lookup before the call. A local path resolves to `LocalWorkspaceHost`, so each
phase can move a group without a change for local users.

## 9. Credentials for agents on the host

- Claude Code, Codex, Gemini CLI, and opencode keep their logins in the home folder of the host (`~/.claude`,
  `~/.codex`, and others). The user logs in one time in a remote terminal tab, for example with `claude` and `/login`.
  The login flows of these agents show a URL and a code for a machine without a browser.
- ShipWarden never copies a login, an API key, or the keychain of the Mac to the host. A user who wants an API key on
  the host sets it in the shell profile of the host.
- The preflight check runs `command -v claude codex gemini opencode` on the host and shows which agents are installed.
  The agent menu of a remote repository shows only those agents.
- GitHub: the pull request features (Review view, checks, the GitHub API) stay on the Mac with the token of the Mac. The
  app reads the remote URL of the repository through the host. Agents that run `gh` or `git push` on the host need the
  login of the host (`gh auth login`) or SSH agent forwarding.
- The usage view (`UsageService`) reads the usage of the logins on the Mac. Remote logins are not in it. See "Open
  questions".

## 10. Security

- **What runs on the host**: only the runtime and the commands that the user or the agents start. It runs as the SSH
  user. It never uses `sudo`. It installs only into `~/.shipwarden/host/`.
- **No listening port**: the runtime listens only on Unix sockets in a 0700 folder, with mode 0600. Nothing listens on
  TCP, on the host or on the Mac. This follows the rule of `HookServer` and `CliServer`.
- **The main socket**: the socket permissions limit it to the user (and root). The daemon also checks a token in
  `hello`. The app reads the token from a 0600 file on the host through SSH. So a process of the same user that does
  not know the token cannot use the socket by mistake.
- **Hook token**: as today, a random token per daemon run, in the environment of each session.
- **MCP tokens**: per session, as today. The Mac keeps only hashes. The config file on the host has mode 0600. Root on
  the host can read it, and root can also read the agent's memory, so this adds no new risk.
- **CLI token**: per daemon run, in `~/.shipwarden/cli.json` on the host with mode 0600.
- **Integrity of the runtime**: the app checks the SHA-256 of the package after the download and the hashes of the
  files on the host after the upload. `swr connect` starts only the build that the app asks for.
- **Remote method calls**: the runtime runs only the methods in its allow list. `exec/run` has a fixed list of
  commands. `files/*` keeps the `resolveInside` checks of `FileService`, so a call cannot leave the worktree root.
- **Trust direction**: the app trusts the runtime as much as it trusts the host. A host that the user does not trust
  can send false agent states or MCP calls, but MCP write tools still need the approval of the user.
- **Agent forwarding**: off by default (section 5).
- **Logs**: the runtime log on the host has no terminal output and no hook bodies, only states and errors.

## 11. Phased delivery

Sizes: S is up to 2 days, M is up to 1 week, L is up to 2 weeks, and XL is more.

| Phase | Content | Size | Useful on its own |
|---|---|---|---|
| 0 | This design doc | S | Decisions for review |
| 1 | **Terminal-only remote worktrees.** Settings › Hosts (add, check, remove). The runtime build in CI for linux x64 and arm64. Download, upload, and versions. `swr daemon` with systemd and `setsid`. `SshWorkspaceHost` with `terminals` and `worktrees`. A remote repository in a project. Create and remove worktrees. Agent tabs and shell tabs with hook states. Reconnect and replay. The Docker test job. | L | Yes: agents run on the host, and the user sees their state and output |
| 2 | **Git.** The `WorkspaceHost` move of `gitChanges`, checkpoints, and the git users in review providers. Changes tab, diffs, commit, push, rebase, branch summaries, and checkpoints for remote worktrees. | L | Yes: review and ship the work of a remote agent |
| 3 | **Files.** File explorer, editor (read and write), search, file watch (recursive `fs.watch` on Linux, Node 20 and newer), media files through `files/readRange`. | M | Yes |
| 4 | **LSP.** `LspTransport` over the link. The server install on the host (the binaries for linux). | M | Yes |
| 5 | **Agent tools.** The MCP relay and the stdio shim. The CLI relay. The chat view and the transcript readers on the host. | M | Yes |
| 6 | **Background work.** Automations, the task queue, and the phone for remote worktrees through the helper. The helper gets an `SshWorkspaceHost` too. | M | Yes |

Phase 1 is the smallest useful slice. Until phase 2, a remote worktree shows "Not available for remote worktrees yet"
in the Changes, Files, and Chat tabs.

### Test strategy

- **Unit tests** (vitest, next to the code, as today):
  - The `ssh` argument builder and the parser of `ssh` errors (host key, permission denied, timeout).
  - The `~/.ssh/config` host list parser.
  - The preflight parser (`uname -sm`, `ldd --version`, `git --version`, `command -v curl`, logind settings, linger).
  - The choice between systemd and `setsid`.
  - The `sw-ssh://` URI helper.
  - The proxy: the method list matches the class methods, and each result survives `JSON.parse(JSON.stringify(…))`.
  - Reconnect: a fake stream that closes, then the `list` and `replay` steps.
  - The MCP and CLI relay with a fake app.
- **Integration tests with Docker sshd**: a new `npm run test:remote` with its own vitest config.
  - A Dockerfile in `test/remote-host/` makes an Ubuntu 22.04 image with `openssh-server`, `git`, `curl`, and a test
    user with a generated key. One variant has systemd as PID 1 (for the systemd path), and one has no systemd (for the
    `setsid` path).
  - The tests run the app-side code (`SshWorkspaceHost`) in plain Node against the container: connect, install the
    runtime, start the daemon, create a worktree, start a PTY that runs `echo`, send a hook event with `curl`, kill the
    `ssh` process, reconnect, and check `replay`. A second test installs a new build and checks that the old daemon
    keeps its session.
  - CI: the `check` job runs on `macos-15`, and GitHub macOS runners have no Docker. So a new job `remote-host` runs on
    `ubuntu-24.04`. It builds the linux runtime and runs `test:remote`. A matrix entry on `ubuntu-24.04-arm` tests
    arm64.
  - Developers run `test:remote` with Docker Desktop on the Mac.
- **Manual tests** before each phase ships: a real host behind a `ProxyJump`, a host that needs a one-time code, a Mac
  that sleeps for one night, and a work network with TLS inspection.

## 12. Risks

| Risk | Effect | Mitigation |
|---|---|---|
| The size of the `WorkspaceHost` move (about 110 call sites) | Regressions for local users | Move one group per phase. Local paths resolve to `LocalWorkspaceHost` with the same instances. |
| node-pty on Linux | The addon does not load on an old or unusual host | Build with glibc 2.28. The preflight check reads the glibc version and refuses older hosts with a clear message. |
| logind stops the `setsid` daemon at logout | Agents stop overnight | The preflight warning with the `loginctl enable-linger` command. |
| Latency | File views and diffs feel slow on a far host | Keep the TanStack Query cache in the page. Batch reads. Move the file watch events, not file polls. |
| The inotify watch limit on Linux | The file watch fails on a large repository | The runtime falls back to a poll of the open folders and tells the user to raise `fs.inotify.max_user_watches`. |
| Path strings everywhere | A `sw-ssh://` path reaches a local `fs` call | A lint rule or a runtime guard in `LocalWorkspaceHost` that throws for a `sw-ssh://` path. |
| Corporate bastions with a second factor | Reconnects ask for a code each time | `ControlPersist=10m` keeps the master. "Connect in terminal" for the code. |
| The download of the runtime through a work VPN | The download fails | Use `TrustedCertificates`. Allow a manual install from a file. |
| One channel for all traffic | A large diff delays terminal output | Bulk data on a second `ssh` command. Limit the size of one message. |

## 13. Open questions

1. **Runtime in the DMG or a download?** This design downloads the package from the GitHub release on the first use.
   The DMG then stays small, but the first host needs a network connection to GitHub from the Mac. The other choice adds
   about 60 MB to each download of the app.
2. **Development builds**: where does `npm run dev` get the linux `pty.node`? A proposal: a script that runs the Docker
   build one time and keeps the result in `~/.cache/shipwarden/`.
3. **The URI form** `sw-ssh://<host id>/<path>`: is a separate field in `Project` better? The URI keeps all stores
   valid without a migration, so this design uses it.
4. **Clone on the host**: phase 1 adds an existing folder on the host. Do we also want "Clone on host" (the
   `repo-clone.ts` flow with `git clone` on the host)?
5. **Agent forwarding**: off by default, with a setting per host. Is that the right default for `git push` on the
   host?
6. **macOS hosts**: a Mac mini is a common build machine. Do we want it in a later phase? It needs the launchd code and
   a separate `cli.json` path.
7. **Usage view**: should the app read the agent usage of the logins on the host too?
8. **Linger**: should the app offer a button that runs `loginctl enable-linger` on the host, or only show the command?
9. **Multiple Macs**: two Macs can connect to the same runtime, as two app windows can connect to one PTY host. Is that
   a feature or a risk (two users of one SSH account)?
