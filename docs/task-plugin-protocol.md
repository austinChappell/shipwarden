# ShipWarden Task Protocol, version 3

A task plugin connects ShipWarden to a task tracker, for example GitHub Issues, Linear,
ClickUp or Jira. Anyone can write a plugin. A plugin is a separate process, so you can write
it in any language.

## Transport

- ShipWarden starts the plugin process and talks to it on stdin and stdout.
- The messages are JSON-RPC 2.0 messages.
- Each message has a header, like in the Language Server Protocol:

  ```
  Content-Length: <number of bytes in the body>\r\n
  \r\n
  <JSON body>
  ```

- The plugin writes logs to stderr. It must not write other text to stdout.
- ShipWarden starts one process for each plugin and repository.

## Plugin folder

A plugin is a folder with a manifest file named `shipwarden-plugin.json`:

```json
{
  "id": "clickup",
  "name": "ClickUp",
  "version": "0.1.0",
  "protocolVersion": 3,
  "command": "node",
  "args": ["index.js"],
  "settings": [
    { "key": "apiToken", "label": "API token", "type": "secret", "required": true,
      "description": "A personal API token from ClickUp settings." },
    { "key": "teamId", "label": "Workspace ID", "type": "string" }
  ]
}
```

| Field | Meaning |
|---|---|
| `id` | A unique ID. Use lowercase letters, digits and hyphens. |
| `command`, `args` | The command that starts the plugin. The working folder is the plugin folder. If `command` is `"node"`, ShipWarden uses its own Node runtime, so the user does not need Node. |
| `settings` | The settings that the user must or can give. `type` is `"string"`, `"secret"` or `"boolean"`. ShipWarden encrypts `"secret"` values. |

ShipWarden finds plugins in two places:

1. The `plugins` folder of ShipWarden (the built-in plugins).
2. `~/.shipwarden/plugins/<plugin folder>` (the plugins that the user installs).

## Connections and the lifecycle

A **connection** is one configured task manager: a plugin with its own settings (for example a ClickUp API token)
and an optional **scope** (for example some ClickUp workspaces or GitHub organizations). The user adds connections in
Settings > Task managers. A user can add two connections of one plugin, for example two ClickUp accounts.
All ShipWarden projects use the connections that are on.

ShipWarden starts one plugin process for each connection and project. Without a project (for the scope list on the
settings page), the process gets no scope and no repositories.

1. ShipWarden sends `initialize`. The plugin answers with its capabilities and its UI description.
2. ShipWarden sends requests.
3. Before ShipWarden stops the plugin, it sends `shutdown`. The plugin answers and then exits.

### `initialize`

Params:

```ts
{
  protocolVersion: 3,
  settings: Record<string, string | boolean>, // The settings of the connection (the manifest settings).
  scope?: string[],                           // The scope IDs of the connection. Absent means all.
  context: {
    repositories: {                           // The repositories of the ShipWarden project. Empty without a project.
      root: string,                           // The main worktree of the repository.
      github?: { owner: string, name: string }// When the "origin" remote is on GitHub.
    }[]
  }
}
```

Result:

```ts
{
  capabilities: {
    update?: boolean,          // tasks/update
    statuses?: boolean,        // tasks/statuses
    statusOrder?: boolean,     // tasks/statusOrder
    comments?: boolean,        // comments/list and comments/create
    actions?: boolean,         // tasks/action
    scopes?: boolean,          // scopes/list
    activity?: boolean         // activity/list
  },
  fields?: FieldDefinition[],  // Extra fields that the task view shows.
  actions?: ActionDefinition[],// Buttons that the task view shows.
  filters?: FilterDefinition[] // Choices for the task list, for example "Assigned to me".
}
```

## Types

```ts
interface Task {
  id: string;            // The ID for later requests.
  key?: string;          // The ID that people use, for example "ENG-123" or "#42".
  title: string;
  url?: string;
  status: Status;
  assignees?: Person[];
  labels?: Label[];
  priority?: { name: string; level: number };  // level: 1 is the highest.
  updatedAt?: string;    // ISO 8601
  description?: string;  // Markdown. tasks/list can leave it out. tasks/get must supply it.
  fields?: Record<string, string | number | boolean | null>;
}

// A collection of tasks with one status workflow. The task view shows one collection at a time.
// ClickUp: a list. GitHub: a repository. Linear: a team. Jira: a project. Asana: a project. Trello: a board.
interface Collection {
  id: string;
  name: string;
  path?: string;         // The location, for example "Engineering / Sprints" or a GitHub owner. The picker groups by it.
  url?: string;          // The collection in the tracker's web app.
  default?: boolean;     // The collection that ShipWarden selects first, before the user selects one.
}

interface Status {
  id: string;
  name: string;
  color?: string;        // A CSS color, for example "#d3d3d3".
  category: 'backlog' | 'todo' | 'in_progress' | 'done' | 'canceled';
  order?: number;        // The position in the workflow. Only used without tasks/statusOrder.
}

interface Person { name: string; avatarUrl?: string }
interface Label { name: string; color?: string }

interface Comment { id: string; author?: Person; body: string; createdAt?: string }

interface FieldDefinition {
  id: string;            // The key in Task.fields.
  label: string;
  type: 'text' | 'number' | 'date' | 'url' | 'boolean';
}

interface ActionDefinition {
  id: string;
  label: string;
  confirm?: string;      // If set, ShipWarden asks the user this question first.
}

interface FilterDefinition {
  id: string;
  label: string;
  default?: boolean;     // The filter that ShipWarden selects first.
}
```

## Requests from ShipWarden

| Method | Params | Result |
|---|---|---|
| `scopes/list` | `{}` | `Scope[]`: all scopes of the settings, also outside `scope` |
| `collections/list` | `{}` | `Collection[]` (required), only in the scope |
| `tasks/list` | `{ collection: string, filter?: string, query?: string, cursor?: string }` | `{ tasks: Task[], nextCursor?: string }` |
| `tasks/get` | `{ id: string }` | `Task` |
| `tasks/update` | `{ id: string, status?: string }` (a status ID) | `Task` |
| `tasks/statuses` | `{ id?: string }` (the statuses that apply to a task) | `Status[]` |
| `tasks/statusOrder` | `{ collection: string }` | `{ statuses: Status[] }` |
| `comments/list` | `{ taskId: string }` | `Comment[]` |
| `comments/create` | `{ taskId: string, body: string }` | `Comment` |
| `tasks/action` | `{ taskId: string, actionId: string }` | `{ message?: string }` |
| `activity/list` | `{ since: string }` (an ISO time) | `{ comments: ActivityComment[] }`: new comments from other people on the user's tasks |
| `shutdown` | none | `null` |

### Activity (the Dashboard)

`activity/list` is optional. The Dashboard shows its comments as "new task comments".
Return only comments from other people, newer than `since`, on tasks of the user (for example, assigned tasks).
A comment before the user's own last comment on the same task does not count, because the user saw it.
ShipWarden keeps the record of seen comments. The plugin does not need to keep it.

```ts
interface ActivityComment {
  id: string; taskId: string; taskKey?: string; taskTitle: string; taskUrl?: string;
  author?: string; body: string; createdAt: string;
}
```

### Collections

Each task source has collections. `collections/list` and the `collection` parameter of `tasks/list` are required.

- A collection has one status workflow. Choose the unit of the tracker that owns the statuses: a ClickUp list, a
  GitHub repository, a Linear team (not a Linear project), a Jira project.
- The user selects one collection in the task view. ShipWarden remembers the last choice for each source (plugin),
  in all repositories and after a restart. Without a choice, ShipWarden selects the collection with `default: true`,
  else the first one.
- ShipWarden sends `collections/list` each time the source starts. If the tracker limits the request rate, keep the
  result for some minutes. The ClickUp plugin keeps it for 10 minutes.
- Filters (for example "Assigned to me") apply inside the selected collection.
- A task ID must be unique in the source, not only in its collection. The GitHub plugin uses `owner/name#123`.

### The status order adapter

`tasks/statusOrder` returns all statuses of the collection's workflow, in order.

- The list view shows its status groups in this order. A status that is not in the result comes after the others.
- The board view shows a column for each status in the result, also without tasks, so a card can move to it.
- Without this request, ShipWarden sorts the groups by category (in progress, to do, backlog, done, canceled),
  then by `Status.order`, then by name, and the board shows only statuses that have tasks.

### Scopes

- A scope is a part of the tracker that a connection can include: a ClickUp workspace, a GitHub user or organization.
  The manifest field `"scopeLabel"` names it in the UI (for example `"workspace"` or `"organization"`).
- `scopes/list` returns `{ id: string, name: string, detail?: string }[]`. The settings page shows them as check boxes.
- With `scope` in `initialize`, `collections/list` returns only collections in those scopes.

### Changes from version 2

- `initialize` has `scope` and `context.repositories` in place of `workspace`. A plugin process serves one connection
  and one project, not one repository.
- `scopes/list` and the manifest field `scopeLabel` are new. The `name` in the `initialize` result is not used:
  the connection has its own name.
- ShipWarden does not load plugins with `"protocolVersion": 2`.

### Changes from version 1

- `collections/list` is new and required. `tasks/list` and `tasks/statusOrder` take a `collection`.
- `Task.container` and the `containers` result of `tasks/statusOrder` are removed.
- ShipWarden did not load plugins with `"protocolVersion": 1`.

A plugin returns a JSON-RPC error when a request fails. ShipWarden shows `error.message` to
the user, so write it for a person to read.

## Notifications from the plugin

| Method | Params | Meaning |
|---|---|---|
| `tasks/changed` | `{ ids?: string[] }` | Tasks changed in the tracker. ShipWarden loads the list again. |

## The JavaScript SDK

`plugins/sdk` has a small JavaScript SDK with no dependencies. It reads and writes the
messages and gives each request to your function:

```js
import { runPlugin } from '../sdk/index.js';

runPlugin({
  initialize: async ({ settings }) => ({ capabilities: { comments: true } }),
  listCollections: async () => [{ id: 'eng', name: 'Engineering', default: true }],
  listTasks: async ({ collection, filter, query }) => ({ tasks: [] }),
  getTask: async ({ id }) => { /* ... */ },
  listComments: async ({ taskId }) => [],
  createComment: async ({ taskId, body }) => { /* ... */ }
});
```


### Network errors and certificates

ShipWarden starts each plugin with `NODE_EXTRA_CA_CERTS` when the user sets extra CA certificates in
Settings › Network, so Node's `fetch` in the plugin trusts them. Wrap `fetch` and use `networkDetail(error)` from the
SDK in the error message. It adds the real cause (for example `SELF_SIGNED_CERT_IN_CHAIN`) and, for a certificate
error, tells the user where to set the certificates.
