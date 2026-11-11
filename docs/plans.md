# Plans

A plan turns an idea into steps, and then runs the steps with agents. A plan belongs to a project. The agent reads all
repositories of the project. Open the Plans view in the sidebar.

## Explore an idea

1. Select "New plan" and write the idea.
2. Select "Explore with an agent". The agent of the first repository runs in print mode. It reads all repositories of
   the project and does not change files. This can take a few minutes. You can leave the page while it works.
3. The agent proposes a title, a summary, and a list of steps. Each step has one repository.

To change the proposal, write feedback under "Revise". The agent keeps the steps that need no change. "Explore again"
replaces all steps.

Claude Code gets `--add-dir` for the other repositories, and Gemini CLI gets `--include-directories`. The read-only
sandbox of Codex can read all folders. opencode gets no option.

## Edit the steps

You can change each step before the plan runs:

- The title, the instructions (Markdown), and the repository.
- The task: no task, a new task, or an existing task. A new task goes into the collection that you select in
  "Settings". ShipWarden makes the new tasks when the plan starts.
- "Open a pull request". Turn it off for an experiment, for example a proof of concept. The branch then stays on this
  Mac.
- The order (the arrows), "Skip" (the eye), and "Remove".

The settings of the plan:

- The task manager and the collection for new tasks. You also pick existing tasks from this collection.
- The agent mode of the step agents. A mode without questions, for example `auto`, lets the plan run without you.
- Draft pull requests.

## Execute the plan

"Execute plan" runs the steps one after the other. For each step, ShipWarden:

1. Makes a worktree on the branch `plan/<plan>-<id>/<number>-<step>`. A step starts from the branch of the last done
   step in the same repository. The first step in a repository starts from the default branch.
2. Links the task to the worktree, and moves the task to the start status of its task manager.
3. Gives the plan, the step, and the earlier pull requests to a new agent. The agent commits its work. It does not push.
4. Waits for the agent to end its turn. A new commit finishes the step. ShipWarden pushes the branch and opens the pull
   request. The pull request targets the branch of the last step in the same repository with a pull request, else the
   default branch.

A pull request of a step in another repository shows as its web address in the body. The body lists the merge order of
all pull requests of the plan. The plan page shows the merge order too.

A step that ends its turn without a new commit waits for you. Answer the agent in its tab. When the agent ends its next
turn, ShipWarden checks the step again. You can also select:

- "Continue": check the worktree for a new commit now.
- "Send the prompt again": send the step to the agent again.
- "Mark done": go to the next step without a pull request.
- "Skip": go to the next step. The worktree stays.

"Pause" stops the plan after the current step. "Resume" continues it.

A notification tells you when a step needs you and when the plan is done. Settings › Notifications › Automations turns
these notifications on and off.

## History

A plan that ran stays in the list. Its page shows the steps, the branches, the tasks, the pull requests, and the merge
order. "Duplicate as a new draft" makes a new draft with the same steps and tasks.

The plans are in `plans.json` in the app data folder. Deleting a project deletes its plans. Deleting a plan does not
remove its worktrees, branches, pull requests, or tasks.
