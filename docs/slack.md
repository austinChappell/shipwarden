# Slack

ShipWarden can connect to one Slack channel through a Slack app of your own:

- When an agent needs input for 10 seconds, ShipWarden posts the question in the channel. Each agent session has one
  thread. The next questions of the same agent go in the same thread.
- A reply in the thread goes to the agent. A reply with one digit (for example `2`) selects that option of a permission
  request or a question menu. Other text goes to the agent as a prompt, followed by Enter. A check mark on your reply
  shows that ShipWarden sent it.
- A message that mentions the app starts an agent in a new worktree. Write the repository first, then the prompt:
  `@ShipWarden web Fix the login bug`. ShipWarden answers in the thread of your message, and the questions of the new
  agent go in the same thread.

The app uses Socket Mode. ShipWarden opens a WebSocket to Slack, so your Mac needs no public address and no open port.

The webhook template of the automations ("Tell Slack when an agent waits") continues to work. It is a separate feature.

## Create the Slack app

1. Open <https://api.slack.com/apps>, click **Create New App**, then **From a manifest**.
2. Select your workspace. Paste the manifest below, then click **Create**.
3. Click **Install to Workspace** and allow the access.
4. Open **OAuth & Permissions** and copy the **Bot User OAuth Token** (`xoxb-…`).
5. Open **Basic Information › App-Level Tokens**. Click **Generate Token and Scopes**, add the scope
   `connections:write`, and generate the token. Copy it (`xapp-…`). A manifest cannot make this token.

```yaml
display_information:
  name: ShipWarden
  description: Questions from your ShipWarden agents, and new agents from Slack.
  background_color: "#1f2328"
features:
  bot_user:
    display_name: ShipWarden
    always_online: true
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - channels:join
      - channels:read
      - chat:write
      - groups:history
      - groups:read
      - reactions:write
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.channels
      - message.groups
  interactivity:
    is_enabled: false
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
```

The scopes:

| Scope | Use |
|---|---|
| `app_mentions:read` | Read the messages that mention the app (agent starts). |
| `channels:history`, `groups:history` | Read the replies in the agent threads of a public or private channel. |
| `channels:read`, `groups:read` | List the channels for the channel picker. |
| `channels:join` | Join the public channel that you select. |
| `chat:write` | Post the questions and the answers. |
| `reactions:write` | Add a check mark to a reply that went to the agent. |

## Connect ShipWarden

1. Open Settings › Slack.
2. Paste the bot token and click **Save**. Paste the app-level token and click **Save**.
3. Select the channel. The app joins a public channel. For a private channel, type `/invite @ShipWarden` in the
   channel first.
4. Add the Slack member IDs of the people who can start and answer agents. In Slack, open a profile, click ⋮, then
   **Copy member ID**.
5. Turn on **Connect to Slack**. The status shows "Connected to <workspace> as @<app>".

## Where the connection runs

The connection runs in the process that holds the automation lock (see "Automations" in
[ARCHITECTURE.md](ARCHITECTURE.md)):

- While a ShipWarden window is open, the app runs it.
- While ShipWarden is closed, the background helper runs it. This needs "Keep agents and phone access running when
  ShipWarden is closed" in Settings › Mobile and "Run while ShipWarden is closed" in Automations.

So Slack gets each question one time only. The threads of the agents are in `slack-threads.json` in the app data
folder, so a reply works after the helper takes over from the app, and back.

While the app is closed, the helper sees the state of an agent from its output only. It can post fewer questions, and
the question text can be missing. A start from Slack while the app is closed works for a prompt, as a start from the
phone does.

## Security

- **The allow list.** Only the Slack member IDs in Settings › Slack can start an agent or send input to an agent. An
  agent can run commands on your Mac, so ShipWarden allows nobody until you add an ID. Another person who mentions the
  app or replies in an agent thread gets one answer with their member ID, and ShipWarden ignores the message.
- **One channel.** ShipWarden reads the events of the selected channel only. It ignores the other channels, the direct
  messages, the messages of bots, and the edits.
- **The tokens.** The tokens are in the login keychain of macOS (items "ShipWarden Slack …"). ShipWarden writes them
  with the `security` tool on its standard input, so they are not in the process list. The background helper runs
  without Electron, so it cannot read values that Electron `safeStorage` encrypts. That is why the Slack tokens do not
  use `safeStorage` as the other tokens do. The settings page never gets a token back.
- **Text in Slack.** The question of the agent goes to Slack. Do not use the connection in a channel where people must
  not see the work of your agents.
- **Network.** The Web API calls and the WebSocket use the trusted CA certificates of Settings › Network.
