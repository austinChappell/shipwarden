import { parentPath, type FilesChangedEvent } from '@shared/files';
import { monaco } from './monaco';

interface Document {
    root: string;
    path: string;
    model: monaco.editor.ITextModel;
    /** The version of the model that matches the file on disk. */
    savedVersion: number;
}

type DirtyListener = (root: string, path: string, dirty: boolean) => void;

function key(root: string, path: string): string {
    return `${root}\0${path}`;
}

/**
 * Keeps one Monaco model for each open file.
 * A model keeps its undo history when the user changes tabs.
 * When a file changes on disk and the user has no unsaved changes, the model loads the new content.
 */
export class DocumentStore {
    private readonly documents = new Map<string, Document>();
    private readonly loading = new Map<string, Promise<Document>>();
    private readonly dirtyListeners = new Set<DirtyListener>();
    /** The number of open documents in each worktree. The store watches a worktree while it has open documents. */
    private readonly openCounts = new Map<string, number>();
    private readonly api = window.shipwarden.files;

    constructor() {
        this.api.onChanged(event => this.onFilesChanged(event));
    }

    async open(root: string, path: string): Promise<monaco.editor.ITextModel> {
        const id = key(root, path);
        const existing = this.documents.get(id);
        if (existing) {
            return existing.model;
        }
        let promise = this.loading.get(id);
        if (!promise) {
            promise = this.load(root, path);
            this.loading.set(id, promise);
            promise.finally(() => this.loading.delete(id));
        }
        return (await promise).model;
    }

    /** Returns the model of the file when the store has the file. Does not load the file. */
    get(root: string, path: string): monaco.editor.ITextModel | undefined {
        return this.documents.get(key(root, path))?.model;
    }

    isDirty(root: string, path: string): boolean {
        const document = this.documents.get(key(root, path));
        return !!document && document.model.getAlternativeVersionId() !== document.savedVersion;
    }

    async save(root: string, path: string): Promise<void> {
        const document = this.documents.get(key(root, path));
        if (!document) {
            return;
        }
        const version = document.model.getAlternativeVersionId();
        await this.api.write(root, path, document.model.getValue());
        document.savedVersion = version;
        this.emitDirty(document);
    }

    /** Removes the model. Unsaved changes are lost. */
    close(root: string, path: string): void {
        const id = key(root, path);
        const document = this.documents.get(id);
        if (!document) {
            return;
        }
        document.model.dispose();
        this.documents.delete(id);
        this.release(root);
    }

    /**
     * Moves the model of a renamed file to the new path. The unsaved changes stay. The undo history is lost, because
     * the model of the new path is a new model.
     */
    async rename(root: string, from: string, to: string): Promise<void> {
        const document = this.documents.get(key(root, from));
        if (!document) {
            return;
        }
        const dirty = this.isDirty(root, from);
        const value = document.model.getValue();
        this.close(root, from);
        const model = await this.open(root, to);
        if (dirty && model.getValue() !== value) {
            model.pushEditOperations([], [{ range: model.getFullModelRange(), text: value }], () => null);
        }
    }

    /** Removes the models of all files in a root. Unsaved changes are lost. */
    closeRoot(root: string): void {
        for (const document of [...this.documents.values()]) {
            if (document.root === root) this.close(root, document.path);
        }
    }

    /**
     * Starts to watch the worktree of an open document. Without its own watch, the store gets change events
     * only while the file explorer shows the same worktree. An agent changes files also when the explorer is closed.
     */
    private retain(root: string): void {
        const count = this.openCounts.get(root) ?? 0;
        if (count === 0) {
            this.api.watch(root);
        }
        this.openCounts.set(root, count + 1);
    }

    private release(root: string): void {
        const count = (this.openCounts.get(root) ?? 1) - 1;
        if (count <= 0) {
            this.openCounts.delete(root);
            this.api.unwatch(root);
        } else {
            this.openCounts.set(root, count);
        }
    }

    onDirtyChange(listener: DirtyListener): () => void {
        this.dirtyListeners.add(listener);
        return () => this.dirtyListeners.delete(listener);
    }

    private async load(root: string, path: string): Promise<Document> {
        const content = await this.api.read(root, path);
        const uri = monaco.Uri.file(`${root}/${path}`);
        const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(content, undefined, uri);
        const document: Document = { root, path, model, savedVersion: model.getAlternativeVersionId() };
        let wasDirty = false;
        model.onDidChangeContent(() => {
            const dirty = model.getAlternativeVersionId() !== document.savedVersion;
            if (dirty !== wasDirty) {
                wasDirty = dirty;
                this.emitDirty(document);
            }
        });
        this.documents.set(key(root, path), document);
        this.retain(root);
        return document;
    }

    private emitDirty(document: Document): void {
        const dirty = this.isDirty(document.root, document.path);
        this.dirtyListeners.forEach(listener => listener(document.root, document.path, dirty));
    }

    private async onFilesChanged(event: FilesChangedEvent): Promise<void> {
        const directories = new Set(event.directories);
        for (const document of this.documents.values()) {
            if (document.root !== event.root || !directories.has(parentPath(document.path))) {
                continue;
            }
            if (this.isDirty(document.root, document.path)) {
                continue;
            }
            let content: string;
            try {
                content = await this.api.read(document.root, document.path);
            } catch {
                // The file was deleted or is not readable now. Keep the last content.
                continue;
            }
            if (content === document.model.getValue()) {
                continue;
            }
            // An edit operation keeps the undo history. setValue would remove it.
            document.model.pushEditOperations([], [{ range: document.model.getFullModelRange(), text: content }], () => null);
            document.savedVersion = document.model.getAlternativeVersionId();
            this.emitDirty(document);
        }
    }
}

export const documents = new DocumentStore();
