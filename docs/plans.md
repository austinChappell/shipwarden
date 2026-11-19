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
- A PR group for the pull requests. It is on by default.

## Execute the plan

"Execute plan" runs the steps one after the other. For each step, ShipWarden:

1. Makes a worktree on a new branch. The branch uses the branch template in Settings › Worktrees, as for a task that
   you start. A step without a task uses the step title as the task title, and `<plan>-<number>` as the task key.
   Without a template, the branch is `plan/<plan>-<id>/<number>-<step>`. When the plan or the repository has the
   branch already, the branch gets `-2`, `-3`, and so on. A step starts from the branch of the last done step in the
   same repository. The first step in a repository starts from the default branch.
2. Links the task to the worktree, and moves the task to the start status of its task manager.
3. Gives the plan, the step, and the earlier pull requests to a new agent. The agent commits its work. It does not push.
4. Waits for the agent to end its turn. A new commit finishes the step. ShipWarden pushes the branch and opens the pull
   request. The pull request targets the branch of the last step in the same repository with a pull request, else the
   default branch.

A pull request of a step in another repository shows as its web address in the body. The body lists the merge order of
all pull requests of the plan. The plan page shows the merge order too.

The first pull request of the plan makes a PR group with the title of the plan. Each new pull request of the plan goes
into the same group. "PR group" under the merge order opens the group. To make no group, turn off "Put the pull
requests in a PR group" in the settings of the plan. When you delete the group, this setting goes off. See [PR groups](pr-groups.md).

A step that ends its turn without a new commit stops and shows "Stopped". The step shows "Needs you" only while its
agent waits for your answer or your permission. Answer the agent in its tab. When the agent ends its next
turn, ShipWarden checks the step again. You can also select:

- "Continue": check the worktree for a new commit now.
- "Send the prompt again": send the step to the agent again.
- "Mark done": go to the next step without a pull request.
- "Skip": go to the next step. The worktree stays.

"Pause" stops the plan after the current step. "Resume" continues it.

A notification tells you when a step stops or fails and when the plan is done. Settings › Notifications › Automations turns
these notifications on and off.

## Add a pull request

You can add a pull request to a plan that ran. The pull request becomes a done step at the end of the plan, and the PR
group of the plan gets it too. The project of the plan must have the repository of the pull request. When a worktree has
the head branch, the step gets that worktree, so that its agent can get prompts.

You can add a pull request in two places:

- The plan page: paste the link of the pull request in the "Add a pull request" card.
- A pull request in the Review view: open the menu of the main button and select "Add to a plan…". Select the plan, then
  select "Add". The plan page opens.

## Prompt the agents

"Prompt the agents" on the plan page sends one prompt to the agents of more than one step. Use it for a change that
touches all the pull requests, for example a rename in the API and in the client.

1. Select the steps. "All" selects each step. Only a done step with a worktree can get the prompt.
2. Write the prompt.
3. Keep "Commit and push" on to update the pull requests. Turn it off to keep the changes on this Mac.
4. Select "Send". Or press ⌘ Enter.

The agent in the worktree of each step gets the prompt. Without an agent, a new agent starts. Each agent also gets the
list of the pull requests of the plan, and it changes only its own worktree. The step shows "Working on your request"
while its agent works. Each step shows "Sent" or the problem.

## History

A plan that ran stays in the list. Its page shows the steps, the branches, the tasks, the pull requests, and the merge
order. "Duplicate as a new draft" makes a new draft with the same steps and tasks.

"Review the pull requests together" in the "More" menu opens the PR group of the plan. A plan that has no group yet
gets one at this time. An agent then reviews all pull requests in one run. See [PR groups](pr-groups.md).

The plans are in `plans.json` in the app data folder. Deleting a project deletes its plans. Deleting a plan does not
remove its worktrees, branches, pull requests, or tasks.
