# PR groups

A PR group is a saved list of pull requests that an agent reviews together. Use a group when one change spans more
than one pull request, for example an API change and the client change that uses it. The pull requests can be in
different repositories, and on GitHub or Azure Repos.

## Make a group

You can make a group in three places:

- The Review view: select "New group" in the "PR groups" section.
- A pull request in the Review view: open the menu of the main button and select "Add to a PR group…".
- A plan makes its group when it opens its first pull request. The group gets the title of the plan, and the merge
  order as its note. Each new pull request of the plan goes into the same group. ShipWarden updates the merge order in
  the note, but only when you did not change the note. "Review the pull requests together" in the "More" menu of the
  plan also opens the group, and turns the group on again for the next pull requests. Turn off "Put the pull requests
  in a PR group" in the settings of the plan to make no group. When you delete the group of a plan, new pull requests
  of the plan do not make a new group.

On the page of the group:

- A group from a plan shows the plan under "Details". Select it to open the plan.
- Paste the link of a pull request, or write `owner/name#12`, and select "Add".
- Write a note for the agent, for example the merge order, or how the pull requests depend on each other.
- The agent gets the pull requests in the order of the list. It runs in the copy of the first pull request. Use the
  arrows on a row to move a pull request up or down.

## Review the group

"Review with agent" reads all pull requests of the group in one run. The agent does not change files and posts nothing.
For each pull request, ShipWarden:

1. Loads the pull request and its changed files again.
2. Makes a local copy at the head commit. This is the same copy that the code view of the Review view uses. A
   repository without a clone in a project gets a clone in `~/.shipwarden/review`.

Then the agent runs in print mode in the copy of the first pull request. It can read the other copies. Claude Code gets
`--add-dir` for the other copies, and Gemini CLI gets `--include-directories`. The read-only sandbox of Codex can read
all folders. opencode gets no option. The agent of the first repository applies, else the default agent.

The prompt has the note, and the description and the diff of each pull request. All diffs share one limit. Each pull
request gets an equal part of the rest of the limit, so a large pull request does not push out the others. The agent
looks most at the problems between the pull requests: contracts that do not match, a missing change on one side, and a
merge order that breaks something.

The review can take a few minutes. You can leave the page while it works.

## The result

- The line comments for each pull request become pending comments on that pull request. Accept or remove each comment,
  then submit the review of each pull request as yourself. The pending comments stay until ShipWarden quits.
- The summary for each pull request goes into the review text of that pull request.
- The summary of the group shows on the page of the group, under "Last review".
- A pull request with new commits since the last review shows "Changed". Select "Review with agent" again to review the
  new commits.

## Prompt the agents

"Prompt the agents" on the page of the group sends one prompt to the agents of more than one pull request. Use it for a
change that touches all the pull requests, for example a fix that the group review found.

1. Select the pull requests. "All" selects each open pull request.
2. Write the prompt.
3. Keep "Commit and push" on to update the pull requests. Turn it off to keep the changes on this Mac.
4. Select "Send". Or press ⌘ Enter.

For each selected pull request, ShipWarden finds the worktree of its head branch in a project. Without one, ShipWarden
makes a worktree that tracks the branch on "origin", and runs the setup script of the repository. A branch in a fork
cannot get a worktree. The agent in the worktree gets the prompt. Without an agent, a new agent starts. Each agent also
gets the list of the pull requests of the group, and it changes only its own worktree. Each pull request shows "Sent"
or the problem.

The groups are in `pr-groups.json` in the app data folder. Deleting a group does not change the pull requests or the
pending comments.
