// A ShipWarden task plugin for GitHub issues. Each repository is a collection.
import { execFile } from 'node:child_process';
import { log, networkDetail, runPlugin } from '../sdk/index.js';
import { onlyIssues, parseTaskId, stateChange, STATUSES, toCollections, toComment, toTask } from './map.js';

const API = 'https://api.github.com';
const PAGE_SIZE = 50;
/** The plugin lists at most this number of pages of repositories, with 100 repositories on each page. */
const MAX_REPO_PAGES = 3;

/** The GitHub repositories ("owner/name") of the ShipWarden projects. The first one is the default collection. */
let projectRepos = [];
/** The owners (users and organizations) in the connection's scope, in lowercase. Undefined means all. */
let owners;
let token;
let login;

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

runPlugin({
    async initialize({ settings, scope, context }) {
        projectRepos = (context?.repositories ?? []).filter(repo => repo.github).map(repo => `${repo.github.owner}/${repo.github.name}`);
        owners = scope ? scope.map(owner => owner.toLowerCase()) : undefined;
        const ownToken = typeof settings.token === 'string' ? settings.token.trim() : '';
        token = ownToken || (await getToken());
        login = (await github('GET', '/user')).login;
        log(`GitHub Issues plugin ready as ${login}.`);
        return {
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
        const repos = [];
        for (let page = 1; page <= MAX_REPO_PAGES; page++) {
            const items = await github('GET', `/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`);
            repos.push(...items);
            if (items.length < 100) {
                break;
            }
        }
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
        return toTask(await github('GET', issuePath(id)), { withDescription: true });
    },

    async updateTask({ id, status }) {
        return toTask(await github('PATCH', issuePath(id), stateChange(status)), { withDescription: true });
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
