import {
    File,
    FileBraces,
    FileCode,
    FileCog,
    FileImage,
    FileLock,
    FileTerminal,
    FileText,
    Folder,
    FolderOpen,
    Package,
    type LucideIcon
} from 'lucide-react';

const BY_NAME: Record<string, LucideIcon> = {
    'package.json': Package,
    'package-lock.json': Package,
    'pnpm-lock.yaml': FileLock,
    'yarn.lock': FileLock,
    'Cargo.lock': FileLock,
    'Dockerfile': FileCog,
    'Makefile': FileTerminal
};

const BY_EXTENSION: Record<string, LucideIcon> = {
    md: FileText,
    mdx: FileText,
    txt: FileText,
    json: FileBraces,
    jsonc: FileBraces,
    ts: FileCode,
    tsx: FileCode,
    js: FileCode,
    jsx: FileCode,
    mjs: FileBraces,
    cjs: FileBraces,
    py: FileCode,
    go: FileCode,
    rs: FileCode,
    swift: FileCode,
    c: FileCode,
    cpp: FileCode,
    h: FileCode,
    java: FileCode,
    kt: FileCode,
    rb: FileCode,
    css: FileCode,
    scss: FileCode,
    html: FileCode,
    sh: FileTerminal,
    zsh: FileTerminal,
    bash: FileTerminal,
    yml: FileCog,
    yaml: FileCog,
    toml: FileCog,
    ini: FileCog,
    lock: FileLock,
    png: FileImage,
    jpg: FileImage,
    jpeg: FileImage,
    gif: FileImage,
    svg: FileImage,
    webp: FileImage,
    ico: FileImage
};

/** Dot files without an extension, for example `.gitignore`, are configuration files. */
function isConfigDotFile(name: string): boolean {
    return name.startsWith('.') && !name.slice(1).includes('.');
}

export function fileIcon(name: string): LucideIcon {
    if (BY_NAME[name]) {
        return BY_NAME[name];
    }
    if (/^tsconfig.*\.json$/.test(name) || /\.config\.[cm]?[jt]s$/.test(name)) {
        return FileCog;
    }
    if (isConfigDotFile(name)) {
        return /^\.(nvmrc|node-version|prettierignore|dockerignore)$/.test(name) ? File : FileCog;
    }
    const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
    return BY_EXTENSION[extension] ?? File;
}

export function folderIcon(open: boolean): LucideIcon {
    return open ? FolderOpen : Folder;
}
