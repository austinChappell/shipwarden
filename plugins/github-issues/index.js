// A ShipWarden task plugin for GitHub issues. Each repository is a collection.
import { execFile } from 'node:child_process';
import { log, networkDetail, runPlugin } from '../sdk/index.js';
import {
    editableParts,
    issueChange,
    labelOption,
    loadPages,
    missingLabels,
    onlyIssues,
    parseTaskId,
    STATUSES,
    toCollections,
    toComment,
    toPerson,
    toTask
} from './map.js';

const API = 'https://api.github.com';
const PAGE_SIZE = 50;
/** The plugin lists at most this number of pages of repositories, with 100 repositories on each page. */
const MAX_REPO_PAGES = 3;
/** The plugin keeps the permissions, the labels and the assignees of a repository for 10 minutes. */
const CACHE_MS = 10 * 60 * 1000;
/** GitHub gives this color to a label that it makes without a color. */
const NEW_LABEL_COLOR = 'ededed';

/** The GitHub repositories ("owner/name") of the ShipWarden projects. The first one is the default collection. */
let projectRepos = [];
/** The owners (users and organizations) in the connection's scope, in lowercase. Undefined means all. */
let owners;
let token;
let login;
/** The permissions of the user in each repository. The key is "owner/name" in lowercase. */
const repoPermissions = new Map();
/** The labels of each repository. */
const repoLabels = new Map();
/** The users that can get issues in each repository. */
const repoAssignees = new Map();

function getToken() {
    if (process.env.GITHUB_TOKEN) {
        return Promise.resolve(process.env.GITHUB_TOKEN);
    }
    return new Promise((resolve, reject) => {
        execFile('gh', ['auth', 'token', '--hostname', 'github.com'], { timeout: 10000 }, (error, stdout) => {
            const value = stdout?.trim();
            if (error || !value) {
                reject(new Error('The GitHub Issues plugin cannot get a GitHub token. Run "gh auth login", or set GITHUB_TOKEN.'));
            } else {
                resolve(value);
            }
        });
    });
}

async function github(method, path, body) {
    let response;
    try {
        response = await fetch(`${API}${path}`, {
            method,
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'User-Agent': 'ShipWarden-GitHub-Issues-Plugin',
                ...(body ? { 'Content-Type': 'application/json' } : {})
            },
            body: body ? JSON.stringify(body) : undefined
        });
    } catch (error) {
        throw new Error(`ShipWarden cannot connect to GitHub: ${networkDetail(error)}`);
    }
    if (!response.ok) {
        let detail = '';
        try {
            detail = (await response.json()).message ?? '';
        } catch {
            // The error has no JSON body.
        }
        throw new Error(`GitHub returned ${response.status} for ${method} ${path}. ${detail}`.trim());
    }
    return response.status === 204 ? null : response.json();
}

/** Returns the REST path of an issue from its task ID. */
function issuePath(id) {
    const { repo, number } = parseTaskId(id, projectRepos[0]);
    return `/repos/${repo}/issues/${number}`;
}

/** Returns the value of `key` in `cache`. When the value is absent or older than 10 minutes, `load` gets it again. */
async function cached(cache, key, load) {
    const entry = cache.get(key.toLowerCase());
    if (entry && Date.now() - entry.at < CACHE_MS) {
        return entry.value;
    }
    const value = await load();
    cache.set(key.toLowerCase(), { value, at: Date.now() });
    return value;
}

/** Returns the permissions of the user in a repository: { admin, maintain, push, triage, pull }. */
function permissionsOf(repo) {
    return cached(repoPermissions, repo, async () => (await github('GET', `/repos/${repo}`)).permissions ?? {});
}

function labelsOf(repo) {
    return cached(repoLabels, repo, () => loadPages(page => github('GET', `/repos/${repo}/labels?per_page=100&page=${page}`), MAX_REPO_PAGES));
}

function assigneesOf(repo) {
    return cached(repoAssignees, repo, () => loadPages(page => github('GET', `/repos/${repo}/assignees?per_page=100&page=${page}`), MAX_REPO_PAGES));
}

/** Returns the permissions of the user in a repository. When GitHub does not give them, the result is empty. */
function permissionsOrNone(repo) {
    return permissionsOf(repo).catch(error => {
        log(`The plugin cannot read the permissions of ${repo}: ${error.message}`);
        return {};
    });
}

/** Converts an issue to a task with the description and the editable parts. */
function fullTask(issue, permissions) {
    return toTask(issue, { withDescription: true, editable: editableParts(issue, permissions, login) });
}

/**
 * Makes the labels that the repository does not have. GitHub needs a label in the repository before an issue can get it.
 * A user without write access cannot make labels. Then GitHub returns an error.
 */
async function makeMissingLabels(repo, names) {
    const missing = missingLabels(names, await labelsOf(repo));
    if (missing.length === 0) {
        return;
    }
    for (const name of missing) {
        try {
            await github('POST', `/repos/${repo}/labels`, { name, color: NEW_LABEL_COLOR });
        } catch (error) {
            // 422: the label exists already, for example because another person made it a few seconds ago.
            if (!/ 422 /.test(error.message)) {
                throw new Error(`ShipWarden cannot make the label "${name}" in ${repo}. ${error.message}`);
            }
        }
    }
    repoLabels.delete(repo.toLowerCase());
}

runPlugin({
    async initialize({ settings, scope, context }) {
        projectRepos = (context?.repositories ?? []).filter(repo => repo.github).map(repo => `${repo.github.owner}/${repo.github.name}`);
        owners = scope ? scope.map(owner => owner.toLowerCase()) : undefined;
        const ownToken = typeof settings.token === 'string' ? settings.token.trim() : '';
        token = ownToken || (await getToken());
        login = (await github('GET', '/user')).login;
        log(`GitHub Issues plugin ready as ${login}.`);
        return {
            // Without a GitHub repository in the projects, the user selects a repository. ShipWarden does not select
            // the first repository of the list, because it has nothing to do with the projects.
            capabilities: { defaultCollectionOnly: true, edit: true },
            fields: [
                { id: 'author', label: 'Author', type: 'text' },
                { id: 'milestone', label: 'Milestone', type: 'text' },
                { id: 'comments', label: 'Comments', type: 'number' }
            ],
            filters: [
                { id: 'open', label: 'Open issues', default: true },
                { id: 'assigned', label: 'Assigned to me' },
                { id: 'closed', label: 'Closed issues' }
            ]
        };
    },

    /** The user and the organizations of the token. The settings page lets the user restrict the connection to some of them. */
    async listScopes() {
        const orgs = await github('GET', '/user/orgs?per_page=100');
        return [{ id: login, name: login, detail: 'your account' }, ...orgs.map(org => ({ id: org.login, name: org.login }))];
    },

    /** Each repository with issues in the scope is a collection. The first GitHub repository of the projects is the default. */
    async listCollections() {
        const repos = await loadPages(
            page => github('GET', `/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`),
            MAX_REPO_PAGES
        );
        const inScope = repo => !owners || owners.includes(repo.split('/')[0].toLowerCase());
        const defaultRepo = projectRepos.find(inScope);
        const collections = toCollections(repos, defaultRepo).filter(collection => inScope(collection.id));
        // A repository of the projects can be outside the first pages, for example a public repository of another owner.
        if (defaultRepo && !collections.some(collection => collection.default)) {
            const [owner, name] = defaultRepo.split('/');
            collections.unshift({ id: defaultRepo, name, path: owner, url: `https://github.com/${defaultRepo}`, default: true });
        }
        return collections;
    },

    async listTasks({ collection, filter = 'open', query, cursor }) {
        if (!collection) {
            throw new Error('Select a GitHub repository.');
        }
        const page = Number(cursor ?? 1);
        let items;
        if (query?.trim()) {
            const state = filter === 'closed' ? 'closed' : 'open';
            const assignee = filter === 'assigned' ? ` assignee:${login}` : '';
            const q = `repo:${collection} is:issue state:${state}${assignee} ${query.trim()}`;
            items = (await github('GET', `/search/issues?q=${encodeURIComponent(q)}&per_page=${PAGE_SIZE}&page=${page}`)).items;
        } else {
            const state = filter === 'closed' ? 'closed' : 'open';
            const assignee = filter === 'assigned' ? `&assignee=${encodeURIComponent(login)}` : '';
            items = await github('GET', `/repos/${collection}/issues?state=${state}${assignee}&sort=updated&per_page=${PAGE_SIZE}&page=${page}`);
        }
        return {
            tasks: onlyIssues(items).map(issue => toTask(issue)),
            nextCursor: items.length === PAGE_SIZE ? String(page + 1) : undefined
        };
    },

    async getTask({ id }) {
        const { repo } = parseTaskId(id, projectRepos[0]);
        const [issue, permissions] = await Promise.all([github('GET', issuePath(id)), permissionsOrNone(repo)]);
        return fullTask(issue, permissions);
    },

    /** Changes the state, the title, the body, the assignees or the labels. The assignees are logins. The labels are names. */
    async updateTask(params) {
        const { repo } = parseTaskId(params.id, projectRepos[0]);
        const body = issueChange(params);
        if (body.labels?.length) {
            await makeMissingLabels(repo, body.labels);
        }
        const [issue, permissions] = await Promise.all([
            Object.keys(body).length > 0 ? github('PATCH', issuePath(params.id), body) : github('GET', issuePath(params.id)),
            permissionsOrNone(repo)
        ]);
        return fullTask(issue, permissions);
    },

    /**
     * The choices for a part of an issue. The assignees: the users that can get issues in the repository.
     * The labels: the labels of the repository. A user with write access can type a new label.
     */
    async listOptions({ id, part }) {
        const { repo } = parseTaskId(id, projectRepos[0]);
        if (part === 'assignees') {
            return { options: (await assigneesOf(repo)).map(toPerson) };
        }
        if (part === 'labels') {
            const [labels, permissions] = await Promise.all([labelsOf(repo), permissionsOrNone(repo)]);
            return { options: labels.map(labelOption), create: !!(permissions.admin || permissions.maintain || permissions.push) };
        }
        throw new Error(`GitHub issues have no options for "${part}".`);
    },

    async listStatuses() {
        return [STATUSES.open, STATUSES.closed, STATUSES.notPlanned];
    },

    async statusOrder() {
        return { statuses: [STATUSES.open, STATUSES.closed, STATUSES.notPlanned] };
    },

    async listComments({ taskId }) {
        return (await github('GET', `${issuePath(taskId)}/comments?per_page=100`)).map(toComment);
    },

    async createComment({ taskId, body }) {
        return toComment(await github('POST', `${issuePath(taskId)}/comments`, { body }));
    }
});
