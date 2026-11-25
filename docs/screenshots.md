# Screenshots of visual changes

The Screenshots tab of a worktree shows the visual result of a frontend pull request. ShipWarden captures each page
for the branch and for the base. The review shows the two images side by side.

## Settings

Open Settings › Repositories and select the repository. The **Screenshots** card has these fields:

| Field | Value |
| --- | --- |
| Preview URL | The address of your dev server, for example `http://localhost:3000`. It must start with `http://` or `https://`. |
| Pages | One path on each line, for example `/` and `/settings`. Each path starts with `/`. At most 20 pages. |
| Wait | Before each capture: a number of milliseconds (at most 60000), or a CSS selector that must show (at most 15 seconds). Empty means no wait. |
| Width | The page width in CSS pixels, from 320 to 3840. Empty means 1280. |

## Capture

ShipWarden has no port for each worktree, so you run the dev server. ShipWarden never starts or stops it, and it cannot
see which worktree the server uses. The capture has two steps:

1. Run the dev server in the worktree of the branch. Open the **Screenshots** tab of the right panel and click
   **Capture branch**.
2. Stop the dev server. Run it in the main worktree of the repository, on the base branch. Click **Capture base**.

When the worktree is the main worktree, check out the base branch there before you capture the base.

Each capture opens the pages in a hidden window. The window uses the session of the in-app browser, so it has the same
cookies and the same certificate rules (Settings › Network). ShipWarden measures the page height and captures the full
page, up to 8000 px. A page that fails gets its error, and the other pages continue.

A capture records the branch and the commit (HEAD) of the worktree that it used. The images stay in
`<app data>/screenshots/<repository>/<branch>/`. A new width removes the images of the other side, because the images
would not match. **Clear** removes the screenshots of the branch.

## Review

Each page shows the base and the branch side by side. **Base** or **Branch** shows one side at the full width of the
panel. Click an image to see it larger.

## Add to PR

**Add to PR** uploads the images and adds one comment to the pull request. ShipWarden asks before it posts. The comment
has a table with the base and the branch of each page, and the commits of both sides.

| Provider | Where the images go |
| --- | --- |
| GitHub | GitHub has no API to add an image to a comment. ShipWarden commits the images to the branch `shipwarden-screenshots` of the repository with the git data API. The branch has no common history with your code. The commit message has `[skip ci]`. The comment links to each file at that commit. For a private repository, readers must be signed in to GitHub to see the images. |
| Azure DevOps | The images become attachments of the pull request (`pullRequests/{id}/attachments/{fileName}`). |
| GitLab | The images go to the uploads of the project (`POST /projects/:id/uploads`). |
| Gitea and Forgejo | The images become attachments of the pull request (`POST /repos/{owner}/{repo}/issues/{index}/assets`). |
| Bitbucket | Not available. Bitbucket Cloud has no API that adds an image to a pull request comment. The **Add to PR** button does not show. Add the images on Bitbucket. |

The token of the review provider must allow these writes: `repo` (or "Contents: write") on GitHub, "Code (read and
write)" on Azure DevOps, and `api` on GitLab.
