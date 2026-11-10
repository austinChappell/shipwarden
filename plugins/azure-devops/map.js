// Converts Azure DevOps REST API 7.1 work items, states and comments to ShipWarden task protocol types.

/** The work item fields that the task list reads. */
export const LIST_FIELDS = [
    'System.Id',
    'System.Title',
    'System.State',
    'System.WorkItemType',
    'System.TeamProject',
    'System.AssignedTo',
    'System.Tags',
    'System.ChangedDate',
    'System.AreaPath',
    'System.IterationPath',
    'Microsoft.VSTS.Common.Priority'
];

/** The order of the Azure state categories in a workflow. */
const CATEGORY_ORDER = ['Proposed', 'InProgress', 'Resolved', 'Completed', 'Removed'];

/** The Azure state categories of closed work items. */
export const CLOSED_CATEGORIES = ['Completed', 'Removed'];

/**
 * Reads the organization setting. The setting can be a name ("contoso"), an organization URL
 * ("https://dev.azure.com/contoso" or "https://contoso.visualstudio.com"), or an Azure DevOps Server collection URL.
 * Returns the base URL of the REST API, without a slash at the end, and the organization name.
 */
export function parseOrganization(value) {
    const text = String(value ?? '')
        .trim()
        .replace(/\/+$/, '');
    if (!text) {
        throw new Error('The Azure DevOps connection needs an organization. Add it in Settings > Task managers.');
    }
    if (/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(text)) {
        return { baseUrl: `https://dev.azure.com/${text}`, name: text };
    }
    let url;
    try {
        url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    } catch {
        throw new Error(`The organization "${text}" is not valid. Use a name, for example "contoso", or a URL, for example "https://dev.azure.com/contoso".`);
    }
    const segments = url.pathname.split('/').filter(Boolean);
    if (url.hostname.toLowerCase() === 'dev.azure.com') {
        if (segments.length === 0) {
            throw new Error('The organization URL has no organization name. Use a URL like "https://dev.azure.com/contoso".');
        }
        return { baseUrl: `https://dev.azure.com/${segments[0]}`, name: decodeURIComponent(segments[0]) };
    }
    const legacy = /^([^.]+)\.visualstudio\.com$/i.exec(url.hostname);
    if (legacy) {
        return { baseUrl: `https://${url.hostname}`, name: legacy[1] };
    }
    // Azure DevOps Server: the URL of the collection, for example "https://tfs.example.com/tfs/DefaultCollection".
    return { baseUrl: `${url.origin}${url.pathname.replace(/\/+$/, '')}`, name: decodeURIComponent(segments.at(-1) ?? url.hostname) };
}

/**
 * Finds the Azure DevOps project of a git remote URL. Azure Repos remotes have these forms:
 * https://dev.azure.com/org/project/_git/repo, https://org@dev.azure.com/org/project/_git/repo,
 * git@ssh.dev.azure.com:v3/org/project/repo and https://org.visualstudio.com/project/_git/repo.
 * Returns the project name, or undefined when the remote is not on Azure Repos.
 */
export function projectOfRemote(remote) {
    const text = String(remote ?? '').trim();
    const ssh = /ssh\.dev\.azure\.com:v3\/[^/]+\/([^/]+)\/[^/]+$/i.exec(text) ?? /vs-ssh\.visualstudio\.com:v3\/[^/]+\/([^/]+)\/[^/]+$/i.exec(text);
    if (ssh) {
        return decodeURIComponent(ssh[1]);
    }
    const https = /dev\.azure\.com\/[^/]+\/([^/]+)\/_git\//i.exec(text) ?? /\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\//i.exec(text);
    return https ? decodeURIComponent(https[1]) : undefined;
}

/** Maps an Azure state category to a ShipWarden status category. */
export function statusCategory(category) {
    switch (category) {
        case 'Proposed':
            return 'todo';
        case 'InProgress':
        case 'Resolved':
            return 'in_progress';
        case 'Completed':
            return 'done';
        case 'Removed':
            return 'canceled';
        default:
            return 'in_progress';
    }
}

/** Azure changes a state by its name, so the status ID is the name. Azure gives colors as hex digits without "#". */
export function toStatus(state, order) {
    return {
        id: state.name,
        name: state.name,
        color: state.color ? `#${String(state.color).replace(/^#/, '')}` : undefined,
        category: statusCategory(state.category),
        ...(order === undefined ? {} : { order })
    };
}

/**
 * Merges the states of the work item types of a project into one workflow. Each work item type has its own states,
 * but a collection has one status list. A state name comes one time. The order is the category order
 * (Proposed, InProgress, Resolved, Completed, Removed), then the order of the first type that has the state.
 * `typeStates` is a list of state lists, one for each work item type.
 */
export function mergeStates(typeStates) {
    const byName = new Map();
    typeStates.forEach((states, typeIndex) => {
        (states ?? []).forEach((state, index) => {
            const key = state.name.toLowerCase();
            if (!byName.has(key)) {
                byName.set(key, { state, rank: [categoryRank(state.category), typeIndex, index] });
            }
        });
    });
    return [...byName.values()].sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.rank[2] - b.rank[2]).map(({ state }) => toStatus(state));
}

function categoryRank(category) {
    const index = CATEGORY_ORDER.indexOf(category);
    return index === -1 ? 1 : index;
}

/** Returns the names of the states in the closed categories (Completed and Removed). */
export function closedStateNames(typeStates) {
    const names = new Set();
    for (const states of typeStates) {
        for (const state of states ?? []) {
            if (CLOSED_CATEGORIES.includes(state.category)) {
                names.add(state.name);
            }
        }
    }
    return [...names];
}

/** Returns the work item types that the project shows. The types in "Microsoft.HiddenCategory" (for example "Code Review Request") are left out. */
export function visibleTypes(types, categories) {
    const hidden = new Set(
        (categories ?? [])
            .filter(category => category.referenceName === 'Microsoft.HiddenCategory')
            .flatMap(category => (category.workItemTypes ?? []).map(type => type.name.toLowerCase()))
    );
    return (types ?? []).filter(type => !type.isDisabled && !hidden.has(type.name.toLowerCase())).map(type => type.name);
}

/** Puts a text in single quotes for WIQL. WIQL escapes a single quote with a second single quote. */
export function wiqlString(value) {
    return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Makes the WIQL query for the task list of one project.
 * `filter` is "assigned", "open" or "all". `closedStates` are the state names to leave out for "assigned" and "open".
 * `areaPath` limits the query to an area and its children. `query` searches the title, or the ID for a number.
 */
export function listQuery({ filter = 'assigned', query, closedStates = [], areaPath, types = [] }) {
    const conditions = ['[System.TeamProject] = @project'];
    if (types.length > 0) {
        conditions.push(`[System.WorkItemType] IN (${types.map(wiqlString).join(', ')})`);
    }
    if (filter === 'assigned') {
        conditions.push('[System.AssignedTo] = @Me');
    }
    if (filter !== 'all' && closedStates.length > 0) {
        conditions.push(`[System.State] NOT IN (${closedStates.map(wiqlString).join(', ')})`);
    }
    if (areaPath?.trim()) {
        conditions.push(`[System.AreaPath] UNDER ${wiqlString(areaPath.trim())}`);
    }
    const needle = query?.trim().replace(/^(?:AB)?#/i, '');
    if (needle) {
        conditions.push(
            /^\d+$/.test(needle)
                ? `([System.Id] = ${Number(needle)} OR [System.Title] CONTAINS ${wiqlString(needle)})`
                : `[System.Title] CONTAINS ${wiqlString(needle)}`
        );
    }
    return `SELECT [System.Id] FROM WorkItems WHERE ${conditions.join(' AND ')} ORDER BY [System.ChangedDate] DESC`;
}

/**
 * Makes the WIQL query for the Dashboard: the work items assigned to the user that changed after `since`.
 * `projects` are the project names in the scope. Undefined means all projects.
 */
export function activityQuery(since, projects) {
    const conditions = ['[System.AssignedTo] = @Me', `[System.ChangedDate] > ${wiqlString(new Date(since).toISOString())}`];
    if (projects) {
        conditions.push(`[System.TeamProject] IN (${projects.map(wiqlString).join(', ')})`);
    }
    return `SELECT [System.Id] FROM WorkItems WHERE ${conditions.join(' AND ')} ORDER BY [System.ChangedDate] DESC`;
}

/** Returns the web URL of a work item. */
export function workItemUrl(baseUrl, project, id) {
    return `${baseUrl}/${encodeURIComponent(project)}/_workitems/edit/${id}`;
}

function person(identity) {
    if (!identity) {
        return undefined;
    }
    if (typeof identity === 'string') {
        // An old API version gives "Display Name <email>".
        return { name: identity.replace(/\s*<[^>]*>$/, '') };
    }
    // The avatar URL needs the token, so the task view cannot show it. The plugin leaves it out.
    return { name: identity.displayName ?? identity.uniqueName ?? 'Unknown' };
}

/** Splits the "System.Tags" field ("tag one; tag two") into labels. */
export function toLabels(tags) {
    return String(tags ?? '')
        .split(';')
        .map(tag => tag.trim())
        .filter(Boolean)
        .map(name => ({ name }));
}

const PRIORITY_NAMES = { 1: 'Critical', 2: 'High', 3: 'Medium', 4: 'Low' };

/**
 * Converts a work item to a task. `states` are the states of the work item type, to give the status its color and
 * category. Without them, the category comes from the state name.
 * The task ID is the work item ID, because a work item ID is unique in the organization.
 * The key is "AB#123": GitHub and Azure Boards link a commit or pull request with this text to the work item.
 */
export function toTask(item, { baseUrl, states, withDescription = false } = {}) {
    const fields = item.fields ?? {};
    const id = String(item.id ?? fields['System.Id']);
    const project = fields['System.TeamProject'];
    const stateName = fields['System.State'] ?? '';
    const state = (states ?? []).find(candidate => candidate.name.toLowerCase() === stateName.toLowerCase());
    const priority = Number(fields['Microsoft.VSTS.Common.Priority']);
    const assignee = person(fields['System.AssignedTo']);
    return {
        id,
        key: `AB#${id}`,
        title: fields['System.Title'] ?? '',
        url: baseUrl && project ? workItemUrl(baseUrl, project, id) : undefined,
        status: state ? toStatus(state) : toStatus({ name: stateName, category: guessCategory(stateName) }),
        assignees: assignee ? [assignee] : [],
        labels: toLabels(fields['System.Tags']),
        priority: priority >= 1 ? { name: PRIORITY_NAMES[priority] ?? `Priority ${priority}`, level: priority } : undefined,
        updatedAt: fields['System.ChangedDate'] ?? undefined,
        description: withDescription ? description(item) : undefined,
        fields: {
            type: fields['System.WorkItemType'] ?? null,
            area: fields['System.AreaPath'] ?? null,
            iteration: fields['System.IterationPath'] ?? null
        }
    };
}

/** Guesses the category of a state of the standard processes (Basic, Agile, Scrum, CMMI) from its name. */
export function guessCategory(name) {
    switch (String(name).toLowerCase()) {
        case 'new':
        case 'to do':
        case 'proposed':
        case 'approved':
            return 'Proposed';
        case 'resolved':
            return 'Resolved';
        case 'done':
        case 'closed':
        case 'completed':
            return 'Completed';
        case 'removed':
            return 'Removed';
        default:
            return 'InProgress';
    }
}

/**
 * Returns the description of a work item as Markdown. Bugs keep the text in "Repro Steps", not in "Description".
 * Azure keeps the field as HTML, or as Markdown when the field uses the Markdown editor ("multilineFieldsFormat").
 */
export function description(item) {
    const fields = item.fields ?? {};
    const formats = item.multilineFieldsFormat ?? {};
    const parts = [];
    for (const [field, heading] of [
        ['System.Description', undefined],
        ['Microsoft.VSTS.TCM.ReproSteps', 'Repro steps'],
        ['Microsoft.VSTS.Common.AcceptanceCriteria', 'Acceptance criteria']
    ]) {
        const value = fields[field];
        if (typeof value !== 'string' || !value.trim()) {
            continue;
        }
        const text = String(formats[field]).toLowerCase() === 'markdown' ? value.trim() : htmlToMarkdown(value);
        if (text) {
            parts.push(heading ? `## ${heading}\n\n${text}` : text);
        }
    }
    return parts.join('\n\n');
}

/** Converts an Azure comment to a protocol comment. Azure keeps comments as HTML, or as Markdown for "format": "markdown". */
export function toComment(comment) {
    const markdown = String(comment.format ?? '').toLowerCase() === 'markdown';
    return {
        id: String(comment.id ?? comment.commentId),
        author: person(comment.createdBy),
        body: markdown ? String(comment.text ?? '') : htmlToMarkdown(comment.text ?? ''),
        createdAt: comment.createdDate
    };
}

/** Returns the comments in time order, without deleted comments. */
export function sortComments(comments) {
    return (comments ?? []).filter(comment => !comment.isDeleted).sort((a, b) => Date.parse(a.createdDate) - Date.parse(b.createdDate));
}

/**
 * Selects the Dashboard comments of one task: comments from other people, newer than `since` and newer than the
 * last comment of the user. `userId` is the identity ID of the user.
 */
export function newComments(comments, userId, since) {
    const sinceMs = Date.parse(since);
    const own = comments.filter(comment => comment.createdBy?.id === userId).map(comment => Date.parse(comment.createdDate));
    const after = Math.max(sinceMs, ...own);
    return comments.filter(comment => !comment.isDeleted && comment.createdBy && comment.createdBy.id !== userId && Date.parse(comment.createdDate) > after);
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text) {
    return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
        if (code[0] === '#') {
            const number = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
            return Number.isFinite(number) ? String.fromCodePoint(number) : match;
        }
        return ENTITIES[code.toLowerCase()] ?? match;
    });
}

function attribute(tag, name) {
    const match = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
    return match ? decodeEntities(match[2] ?? match[3] ?? match[4] ?? '') : undefined;
}

/**
 * Converts the HTML of an Azure rich text field to Markdown. It keeps headings, paragraphs, line breaks, bold,
 * italic, code, links, images and lists. It removes the other tags and keeps their text.
 */
export function htmlToMarkdown(html) {
    let text = String(html ?? '');
    if (!/<[a-z!/][^>]*>|&[#a-z0-9]+;/i.test(text)) {
        return text.trim();
    }
    const blocks = [];
    // Keep code blocks as they are. A placeholder protects them from the other replacements.
    text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_match, code) => {
        const plain = decodeEntities(code.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''));
        blocks.push(`\n\n\`\`\`\n${plain.replace(/\n+$/, '')}\n\`\`\`\n\n`);
        return `\u0000${blocks.length - 1}\u0000`;
    });
    text = text
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
        .replace(/\r?\n/g, ' ')
        .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_match, level, inner) => `\n\n${'#'.repeat(Number(level))} ${inner.trim()}\n\n`)
        .replace(/<(strong|b)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi, (_match, _tag, _attrs, inner) => (inner.trim() ? `**${inner.trim()}**` : inner))
        .replace(/<(em|i)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi, (_match, _tag, _attrs, inner) => (inner.trim() ? `*${inner.trim()}*` : inner))
        .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_match, inner) => `\`${inner}\``)
        .replace(/<a\s[^>]*>([\s\S]*?)<\/a>/gi, (match, inner) => {
            const href = attribute(match, 'href');
            const label = inner.replace(/<[^>]+>/g, '').trim();
            // A mention ("@Name") has the href "#". The text is enough.
            return href && href !== '#' && !href.startsWith('#') && label !== href ? `[${label || href}](${href})` : label || href || '';
        })
        .replace(/<img\s[^>]*>/gi, tag => {
            const src = attribute(tag, 'src');
            return src ? `![${attribute(tag, 'alt') ?? ''}](${src})` : '';
        })
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<hr[^>]*>/gi, '\n\n---\n\n');
    text = convertLists(text);
    text = text
        .replace(/<\/?(p|div|table|tbody|thead|blockquote|section)[^>]*>/gi, '\n\n')
        .replace(/<\/tr>/gi, '\n')
        .replace(/<\/t[dh]>/gi, ' ')
        .replace(/<[^>]+>/g, '');
    text = decodeEntities(text)
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n[ \t]+(?=[^ \t\-\d*])/g, '\n')
        .replace(/(\S)[ \t]{2,}/g, '$1 ')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/\u0000(\d+)\u0000/g, (_match, index) => blocks[Number(index)])
        .replace(/\n{3,}/g, '\n\n');
    return text.trim();
}

/** Converts <ul> and <ol> lists to Markdown lists. Inner lists come first, so a nested list gets an indent. */
function convertLists(html) {
    let text = html;
    const innermost = /<(ul|ol)[^>]*>((?:(?!<(?:ul|ol)[\s>])[\s\S])*?)<\/\1>/i;
    for (let match = innermost.exec(text); match; match = innermost.exec(text)) {
        const ordered = match[1].toLowerCase() === 'ol';
        const items = [...match[2].matchAll(/<li[^>]*>([\s\S]*?)(?:<\/li>|(?=<li[\s>])|$)/gi)].map(item => item[1]);
        const lines = items.map((item, index) => {
            const marker = ordered ? `${index + 1}.` : '-';
            const body = item
                .replace(/<\/?p[^>]*>/gi, ' ')
                .trim()
                .split('\n')
                .map((line, lineIndex) => (lineIndex === 0 ? line : `   ${line}`))
                .join('\n');
            return `${marker} ${body}`;
        });
        text = `${text.slice(0, match.index)}\n${lines.join('\n')}\n${text.slice(match.index + match[0].length)}`;
    }
    return text;
}
