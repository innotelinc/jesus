import { create } from 'zustand';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { FileNode } from '@/lib/jmap/types';

export interface FileResource {
  id: string;
  name: string;
  serverName: string;
  isDirectory: boolean;
  contentType: string;
  contentLength: number;
  lastModified: string;
  blobId: string | null;
  parentId: string | null;
}

interface UploadProgress {
  name: string;
  loaded: number;
  total: number;
  current: number;
  totalFiles: number;
}

interface ClipboardState {
  mode: 'cut' | 'copy';
  ids: string[];
  names: string[];
  serverNames: string[];
  sourceParentId: string | null;
  sourcePath: string;
}

interface UndoAction {
  type: 'rename' | 'move';
  entries: { id: string; from: Partial<Pick<FileNode, 'name' | 'parentId'>>; to: Partial<Pick<FileNode, 'name' | 'parentId'>> }[];
  sourceParentId: string | null;
}

interface FileState {
  currentParentId: string | null;
  currentPath: string;
  pathStack: { id: string | null; name: string }[];
  resources: FileResource[];
  isLoading: boolean;
  error: string | null;
  supportsFiles: boolean | null;
  selectedResources: Set<string>;
  uploadProgress: UploadProgress | null;
  client: IJMAPClient | null;
  /** Which connected account's files are being browsed. Pro shell only - null in single-account contexts. */
  currentAccountId: string | null;
  clipboard: ClipboardState | null;
  uploadAbortController: AbortController | null;
  favorites: string[];
  recentFiles: { name: string; id: string; timestamp: number }[];
  lastAction: UndoAction | null;

  // Actions
  initClient: (client: IJMAPClient, accountId?: string | null) => void;
  /** Detach the current client and reset browse state. Used by the Pro shell to return to the cross-account picker. */
  clearClient: () => void;
  checkSupport: () => Promise<boolean>;
  navigate: (parentId: string | null, name?: string) => Promise<void>;
  navigateByPath: (path: string) => Promise<void>;
  navigateUp: () => Promise<void>;
  refresh: () => Promise<void>;
  createDirectory: (name: string) => Promise<void>;
  uploadFile: (file: File) => Promise<void>;
  uploadFiles: (files: File[]) => Promise<void>;
  uploadFolder: (files: File[]) => Promise<void>;
  cancelUpload: () => void;
  deleteResource: (name: string) => Promise<void>;
  deleteResources: (names: string[]) => Promise<void>;
  renameResource: (oldName: string, newName: string) => Promise<void>;
  downloadResource: (name: string) => Promise<void>;
  downloadResources: (names: string[]) => Promise<void>;
  getImageUrl: (name: string) => Promise<string>;
  getFileContent: (name: string) => Promise<{ blob: Blob; contentType: string }>;
  createTextFile: (name: string) => Promise<void>;
  duplicateResource: (name: string) => Promise<void>;
  moveToFolder: (names: string[], targetFolder: string) => Promise<void>;
  moveToParent: (names: string[]) => Promise<void>;
  cutResources: (names: string[]) => void;
  copyResources: (names: string[]) => void;
  pasteResources: () => Promise<void>;
  selectResource: (name: string | null) => void;
  toggleSelect: (name: string) => void;
  selectAll: () => void;
  clearSelection: () => void;
  setSelection: (names: Set<string>) => void;
  listPath: (path: string) => Promise<FileResource[]>;
  listByParentId: (parentId: string | null) => Promise<FileResource[]>;
  toggleFavorite: (path: string) => void;
  addRecentFile: (name: string, id: string) => void;
  undoLastAction: () => Promise<void>;
}

const DIRECTORY_TYPES = new Set(['d', 'application/x-directory', 'text/directory', 'httpd/unix-directory', 'inode/directory']);

function isDirectoryType(type: string | undefined): boolean {
  if (!type) return false;
  return DIRECTORY_TYPES.has(type) || type.includes('directory');
}

// Direct children of a given parent in the FileNode hierarchy.
function childrenOf(nodes: FileNode[], parentId: string | null): FileNode[] {
  return nodes.filter(n => (n.parentId ?? null) === parentId);
}

function nodeToResource(node: FileNode): FileResource {
  const isDir = isDirectoryType(node.type);
  return {
    id: node.id,
    name: node.name,
    serverName: node.name,
    isDirectory: isDir,
    contentType: isDir ? '' : node.type,
    contentLength: node.size,
    lastModified: node.updated || node.created,
    blobId: node.blobId,
    parentId: node.parentId,
  };
}

function sortResources(resources: FileResource[]): FileResource[] {
  // Directories first, then alphabetically.
  return resources.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

// Resolve a display path (e.g. "/Documents/Notes") to a FileNode id by walking
// the hierarchy from the root. Returns null for the root, or undefined if any
// segment can't be found.
function resolvePathToId(nodes: FileNode[], path: string): string | null | undefined {
  if (path === '/' || path === '') return null;
  const segments = path.split('/').filter(Boolean);
  let parentId: string | null = null;
  for (const segment of segments) {
    const match: FileNode | undefined = childrenOf(nodes, parentId).find(n => n.name === segment && isDirectoryType(n.type));
    if (!match) return undefined;
    parentId = match.id;
  }
  return parentId;
}

function getUniqueName(name: string, existingNames: Set<string>): string {
  if (!existingNames.has(name)) return name;
  const dotIndex = name.lastIndexOf('.');
  const base = dotIndex > 0 ? name.substring(0, dotIndex) : name;
  const ext = dotIndex > 0 ? name.substring(dotIndex) : '';
  let counter = 1;
  while (existingNames.has(`${base} (${counter})${ext}`)) counter++;
  return `${base} (${counter})${ext}`;
}

function buildPathFromStack(stack: { id: string | null; name: string }[]): string {
  if (stack.length <= 1) return '/';
  return '/' + stack.slice(1).map(s => s.name).join('/');
}

export const useFileStore = create<FileState>((set, get) => ({
  currentParentId: null,
  currentPath: '/',
  pathStack: [{ id: null, name: '' }],
  resources: [],
  isLoading: false,
  error: null,
  supportsFiles: null,
  selectedResources: new Set<string>(),
  uploadProgress: null,
  client: null,
  currentAccountId: null,
  clipboard: null,
  uploadAbortController: null,
  lastAction: null,
  favorites: (() => {
    try { return JSON.parse(localStorage.getItem('files-favorites') || '[]'); } catch { return []; }
  })(),
  recentFiles: (() => {
    try { return JSON.parse(localStorage.getItem('files-recent-files') || '[]'); } catch { return []; }
  })(),

  initClient: (client: IJMAPClient, accountId?: string | null) => {
    const patch: Partial<FileState> = { client };
    if (accountId !== undefined) patch.currentAccountId = accountId;
    set(patch);
  },

  clearClient: () => {
    set({
      client: null,
      currentAccountId: null,
      supportsFiles: null,
      pathStack: [{ id: null, name: '' }],
      currentPath: '/',
      currentParentId: null,
      resources: [],
      selectedResources: new Set<string>(),
      error: null,
      isLoading: false,
    });
  },

  checkSupport: async () => {
    const { client } = get();
    if (!client) {
      set({ supportsFiles: false });
      return false;
    }
    // First check capability, then probe with a real request
    const supported = await client.probeFileNodeSupport();
    if (!supported) {
      console.warn('[Files] JMAP FileNode not supported. Available capabilities:', Object.keys(client.getCapabilities()));
    }
    set({ supportsFiles: supported });
    return supported;
  },

  navigate: async (parentId: string | null, name?: string) => {
    const { client, pathStack } = get();
    if (!client) return;

    set({ isLoading: true, error: null, currentParentId: parentId, selectedResources: new Set() });

    // Update path stack
    let newStack: { id: string | null; name: string }[];
    if (parentId === null) {
      newStack = [{ id: null, name: '' }];
    } else {
      // Check if navigating to a parent in the stack
      const existingIdx = pathStack.findIndex(s => s.id === parentId);
      if (existingIdx >= 0) {
        newStack = pathStack.slice(0, existingIdx + 1);
      } else {
        newStack = [...pathStack, { id: parentId, name: name || parentId }];
      }
    }

    const newPath = buildPathFromStack(newStack);
    set({ pathStack: newStack, currentPath: newPath });

    try { localStorage.setItem('files-last-parent-id', parentId || ''); } catch { /* ignore */ }
    try { localStorage.setItem('files-path-stack', JSON.stringify(newStack)); } catch { /* ignore */ }

    try {
      // Fetch the whole tree once and select the current parent's direct
      // children locally. Hierarchy is derived from parentId links, exactly as
      // the JMAP FileNode spec intends (issue #379).
      const allNodes = await client.listAllFileNodes();
      const resources = sortResources(childrenOf(allNodes, parentId).map(nodeToResource));

      // Prune recent files whose backing node no longer exists on the server
      const { recentFiles } = get();
      const existingIds = new Set(allNodes.map(n => n.id));
      const prunedRecent = recentFiles.filter(r => existingIds.has(r.id));
      if (prunedRecent.length !== recentFiles.length) {
        try { localStorage.setItem('files-recent-files', JSON.stringify(prunedRecent)); } catch { /* ignore */ }
        set({ resources, recentFiles: prunedRecent, isLoading: false });
      } else {
        set({ resources, isLoading: false });
      }
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to list directory',
        isLoading: false,
        resources: [],
      });
    }
  },

  navigateByPath: async (path: string) => {
    const { pathStack, navigate } = get();
    if (path === '/') {
      await navigate(null);
      return;
    }
    // Try to match the path against the current pathStack
    const segments = path.split('/').filter(Boolean);
    const targetDepth = segments.length;
    // pathStack[0] is root (id: null, name: ''), subsequent entries match path segments
    if (targetDepth < pathStack.length) {
      const entry = pathStack[targetDepth];
      // Verify the names match
      const stackPath = pathStack.slice(1, targetDepth + 1).map(s => s.name).join('/');
      if (stackPath === segments.join('/')) {
        await navigate(entry.id, entry.name);
        return;
      }
    }
    // Fallback: resolve the path against the live hierarchy (covers favorites
    // and recent paths outside the current breadcrumb stack).
    const { client } = get();
    if (client) {
      try {
        const allNodes = await client.listAllFileNodes();
        const id = resolvePathToId(allNodes, path);
        if (id !== undefined) {
          await navigate(id, segments[segments.length - 1]);
        }
      } catch { /* ignore */ }
    }
  },

  navigateUp: async () => {
    const { pathStack, navigate } = get();
    if (pathStack.length <= 1) return;
    const parent = pathStack[pathStack.length - 2];
    await navigate(parent.id, parent.name);
  },

  refresh: async () => {
    const { currentParentId, navigate, pathStack } = get();
    const currentEntry = pathStack[pathStack.length - 1];
    await navigate(currentParentId, currentEntry?.name);
  },

  createDirectory: async (name: string) => {
    const { client, currentParentId, refresh } = get();
    if (!client) return;

    await client.createFileDirectory(name, currentParentId);
    await refresh();
  },

  uploadFile: async (file: File) => {
    const { client, currentParentId } = get();
    if (!client) return;

    const abortController = new AbortController();
    set({ uploadAbortController: abortController });
    set({ uploadProgress: { name: file.name, loaded: 0, total: file.size, current: 1, totalFiles: 1 } });

    try {
      if (abortController.signal.aborted) return;
      const { blobId, type } = await client.uploadBlob(file, {
        signal: abortController.signal,
        onProgress: (loaded, total) => {
          set({ uploadProgress: { name: file.name, loaded, total, current: 1, totalFiles: 1 } });
        },
      });
      if (abortController.signal.aborted) return;
      set({ uploadProgress: { name: file.name, loaded: file.size, total: file.size, current: 1, totalFiles: 1 } });
      await client.createFileNode(file.name, blobId, type || file.type || 'application/octet-stream', file.size, currentParentId);
    } finally {
      set({ uploadProgress: null, uploadAbortController: null });
    }
  },

  uploadFiles: async (files: File[]) => {
    const { client, currentParentId, resources } = get();
    if (!client) return;

    const abortController = new AbortController();
    set({ uploadAbortController: abortController });
    const totalFiles = files.length;
    const existingNames = new Set(resources.map(r => r.name));

    for (let i = 0; i < files.length; i++) {
      if (abortController.signal.aborted) break;
      const file = files[i];
      const uniqueName = getUniqueName(file.name, existingNames);
      existingNames.add(uniqueName);
      set({ uploadProgress: { name: file.name, loaded: 0, total: file.size, current: i + 1, totalFiles } });

      try {
        const idx = i;
        const { blobId, type } = await client.uploadBlob(file, {
          signal: abortController.signal,
          onProgress: (loaded, total) => {
            set({ uploadProgress: { name: file.name, loaded, total, current: idx + 1, totalFiles } });
          },
        });
        if (abortController.signal.aborted) break;
        set({ uploadProgress: { name: file.name, loaded: file.size, total: file.size, current: i + 1, totalFiles } });
        await client.createFileNode(uniqueName, blobId, type || file.type || 'application/octet-stream', file.size, currentParentId);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') break;
        set({ uploadProgress: null, uploadAbortController: null });
        throw err;
      }
    }
    set({ uploadProgress: null, uploadAbortController: null });
    await get().refresh();
  },

  cancelUpload: () => {
    const { uploadAbortController } = get();
    if (uploadAbortController) {
      uploadAbortController.abort();
      set({ uploadProgress: null, uploadAbortController: null });
    }
  },

  uploadFolder: async (files: File[]) => {
    const { client, currentParentId } = get();
    if (!client || files.length === 0) return;

    const abortController = new AbortController();
    set({ uploadAbortController: abortController });
    const totalFiles = files.length;

    // Collect unique directory paths (relative to the dropped folder) and
    // create them as real nested directories, mapping each path to its node id.
    const dirs = new Set<string>();
    for (const file of files) {
      const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      const parts = relativePath.split('/');
      for (let i = 1; i < parts.length; i++) {
        dirs.add(parts.slice(0, i).join('/'));
      }
    }

    // Map a directory path to its created node id. Root ('') maps to the
    // current folder we are uploading into.
    const dirIds = new Map<string, string | null>();
    dirIds.set('', currentParentId);

    const sortedDirs = [...dirs].sort((a, b) => a.split('/').length - b.split('/').length);
    for (const dir of sortedDirs) {
      if (abortController.signal.aborted) break;
      const slash = dir.lastIndexOf('/');
      const parentPath = slash >= 0 ? dir.slice(0, slash) : '';
      const dirName = slash >= 0 ? dir.slice(slash + 1) : dir;
      const parentId = dirIds.get(parentPath) ?? currentParentId;
      try {
        const created = await client.createFileDirectory(dirName, parentId);
        dirIds.set(dir, created.id);
      } catch {
        // Directory may already exist - leave it unmapped; files fall back to
        // the closest known parent below.
      }
    }

    // Upload files into their containing directory.
    for (let i = 0; i < files.length; i++) {
      if (abortController.signal.aborted) break;
      const file = files[i];
      const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      const slash = relativePath.lastIndexOf('/');
      const dirPath = slash >= 0 ? relativePath.slice(0, slash) : '';
      const parentId = dirIds.get(dirPath) ?? currentParentId;

      set({ uploadProgress: { name: relativePath, loaded: 0, total: file.size, current: i + 1, totalFiles } });

      try {
        const { blobId, type } = await client.uploadBlob(file);
        if (abortController.signal.aborted) break;
        set({ uploadProgress: { name: relativePath, loaded: file.size, total: file.size, current: i + 1, totalFiles } });
        await client.createFileNode(file.name, blobId, type || file.type || 'application/octet-stream', file.size, parentId);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') break;
        set({ uploadProgress: null, uploadAbortController: null });
        throw err;
      }
    }
    set({ uploadProgress: null, uploadAbortController: null });
    await get().refresh();
  },

  deleteResource: async (name: string) => {
    const { client, resources, recentFiles, refresh } = get();
    if (!client) return;

    const resource = resources.find(r => r.name === name);
    if (!resource) return;

    // The server removes descendant nodes (onDestroyRemoveChildren).
    await client.destroyFileNodes([resource.id]);
    const nextRecentFiles = recentFiles.filter(r => r.id !== resource.id);
    set({ recentFiles: nextRecentFiles });
    try { localStorage.setItem('files-recent-files', JSON.stringify(nextRecentFiles)); } catch { /* ignore */ }
    await refresh();
  },

  deleteResources: async (names: string[]) => {
    const { client, resources, recentFiles, refresh } = get();
    if (!client) return;

    const idsToDelete: string[] = [];
    for (const name of names) {
      const resource = resources.find(r => r.name === name);
      if (resource) idsToDelete.push(resource.id);
    }

    if (idsToDelete.length === 0) return;

    // The server removes descendant nodes (onDestroyRemoveChildren).
    await client.destroyFileNodes(idsToDelete);
    const deletedIdSet = new Set(idsToDelete);
    const nextRecentFiles = recentFiles.filter(r => !deletedIdSet.has(r.id));
    set({ selectedResources: new Set() });
    set({ recentFiles: nextRecentFiles });
    try { localStorage.setItem('files-recent-files', JSON.stringify(nextRecentFiles)); } catch { /* ignore */ }
    await refresh();
  },

  renameResource: async (oldName: string, newName: string) => {
    const { client, resources, refresh } = get();
    if (!client) return;

    const resource = resources.find(r => r.name === oldName);
    if (!resource) return;

    await client.updateFileNode(resource.id, { name: newName });

    set({
      lastAction: {
        type: 'rename',
        entries: [{ id: resource.id, from: { name: oldName }, to: { name: newName } }],
        sourceParentId: null,
      },
    });
    await refresh();
  },

  downloadResource: async (name: string) => {
    const { client, resources } = get();
    if (!client) return;

    const resource = resources.find(r => r.name === name);
    if (!resource?.blobId) return;

    await client.downloadBlob(resource.blobId, resource.name, resource.contentType);
  },

  downloadResources: async (names: string[]) => {
    const { downloadResource } = get();
    for (const name of names) {
      await downloadResource(name);
    }
  },

  getImageUrl: async (name: string) => {
    const { client, resources } = get();
    if (!client) throw new Error('No client');

    const resource = resources.find(r => r.name === name);
    if (!resource?.blobId) throw new Error('No blob');

    return client.fetchBlobAsObjectUrl(resource.blobId, resource.name, resource.contentType);
  },

  getFileContent: async (name: string) => {
    const { client, resources } = get();
    if (!client) throw new Error('No client');

    const resource = resources.find(r => r.name === name);
    if (!resource?.blobId) throw new Error('No blob');

    const url = client.getBlobDownloadUrl(resource.blobId, resource.name, resource.contentType);
    const response = await fetch(url, {
      headers: { 'Authorization': client.getAuthHeader() },
    });
    if (!response.ok) throw new Error(`Failed to fetch file: ${response.status}`);
    const blob = await response.blob();
    return { blob, contentType: resource.contentType || 'application/octet-stream' };
  },

  createTextFile: async (name: string) => {
    const { client, currentParentId, refresh } = get();
    if (!client) return;

    const emptyBlob = new File([''], name, { type: 'text/plain' });
    const { blobId } = await client.uploadBlob(emptyBlob);
    await client.createFileNode(name, blobId, 'text/plain', 0, currentParentId);
    await refresh();
  },

  duplicateResource: async (name: string) => {
    const { client, resources, currentParentId, refresh } = get();
    if (!client) return;

    const resource = resources.find(r => r.name === name);
    if (!resource) return;

    const dotIdx = name.lastIndexOf('.');
    const copyName = dotIdx > 0
      ? `${name.substring(0, dotIdx)} (copy)${name.substring(dotIdx)}`
      : `${name} (copy)`;

    await client.copyFileNode(resource.id, copyName, currentParentId);
    await refresh();
  },

  moveToFolder: async (names: string[], targetFolder: string) => {
    const { client, resources, refresh } = get();
    if (!client) return;

    const targetResource = resources.find(r => r.name === targetFolder && r.isDirectory);
    if (!targetResource) return;

    const entries: UndoAction['entries'] = [];
    for (const name of names) {
      const resource = resources.find(r => r.name === name);
      if (!resource || resource.id === targetResource.id) continue;
      await client.updateFileNode(resource.id, { parentId: targetResource.id });
      entries.push({ id: resource.id, from: { parentId: resource.parentId }, to: { parentId: targetResource.id } });
    }
    set({
      selectedResources: new Set(),
      lastAction: { type: 'move', entries, sourceParentId: null },
    });
    await refresh();
  },

  moveToParent: async (names: string[]) => {
    const { client, resources, pathStack, refresh } = get();
    if (!client || pathStack.length <= 1) return;

    // Move into the grandparent of the current folder's contents, i.e. the
    // entry one level up in the breadcrumb stack.
    const newParentId = pathStack[pathStack.length - 2].id;

    const entries: UndoAction['entries'] = [];
    for (const name of names) {
      const resource = resources.find(r => r.name === name);
      if (!resource) continue;
      await client.updateFileNode(resource.id, { parentId: newParentId });
      entries.push({ id: resource.id, from: { parentId: resource.parentId }, to: { parentId: newParentId } });
    }
    set({
      selectedResources: new Set(),
      lastAction: { type: 'move', entries, sourceParentId: null },
    });
    await refresh();
  },

  cutResources: (names: string[]) => {
    const { currentPath, currentParentId, resources } = get();
    const ids = names.map(n => resources.find(r => r.name === n)?.id).filter(Boolean) as string[];
    const serverNames = names.map(n => resources.find(r => r.name === n)?.serverName).filter(Boolean) as string[];
    set({ clipboard: { mode: 'cut', ids, names, serverNames, sourceParentId: currentParentId, sourcePath: currentPath } });
  },

  copyResources: (names: string[]) => {
    const { currentPath, currentParentId, resources } = get();
    const ids = names.map(n => resources.find(r => r.name === n)?.id).filter(Boolean) as string[];
    const serverNames = names.map(n => resources.find(r => r.name === n)?.serverName).filter(Boolean) as string[];
    set({ clipboard: { mode: 'copy', ids, names, serverNames, sourceParentId: currentParentId, sourcePath: currentPath } });
  },

  pasteResources: async () => {
    const { client, currentParentId, clipboard, refresh } = get();
    if (!client || !clipboard) return;

    const entries: UndoAction['entries'] = [];

    for (let i = 0; i < clipboard.ids.length; i++) {
      const id = clipboard.ids[i];
      const displayName = clipboard.names[i];

      if (clipboard.mode === 'cut') {
        await client.updateFileNode(id, { parentId: currentParentId });
        entries.push({ id, from: { parentId: clipboard.sourceParentId }, to: { parentId: currentParentId } });
      } else {
        await client.copyFileNode(id, displayName, currentParentId);
      }
    }

    if (clipboard.mode === 'cut') {
      set({
        clipboard: null,
        lastAction: { type: 'move', entries, sourceParentId: null },
      });
    }
    await refresh();
  },

  selectResource: (name: string | null) => {
    set({ selectedResources: name ? new Set([name]) : new Set() });
  },

  toggleSelect: (name: string) => {
    const { selectedResources } = get();
    const next = new Set(selectedResources);
    if (next.has(name)) {
      next.delete(name);
    } else {
      next.add(name);
    }
    set({ selectedResources: next });
  },

  selectAll: () => {
    const { resources } = get();
    set({ selectedResources: new Set(resources.map(r => r.name)) });
  },

  clearSelection: () => {
    set({ selectedResources: new Set() });
  },

  setSelection: (names: Set<string>) => {
    set({ selectedResources: new Set(names) });
  },

  listPath: async (path: string) => {
    const { client } = get();
    if (!client) return [];

    try {
      const allNodes = await client.listAllFileNodes();
      const parentId = resolvePathToId(allNodes, path);
      if (parentId === undefined) return [];
      return sortResources(childrenOf(allNodes, parentId).map(nodeToResource));
    } catch {
      return [];
    }
  },

  listByParentId: async (parentId: string | null) => {
    const { client } = get();
    if (!client) return [];
    try {
      const allNodes = await client.listAllFileNodes();
      return sortResources(childrenOf(allNodes, parentId).map(nodeToResource));
    } catch {
      return [];
    }
  },

  toggleFavorite: (path: string) => {
    const { favorites } = get();
    const next = favorites.includes(path)
      ? favorites.filter(f => f !== path)
      : [...favorites, path];
    set({ favorites: next });
    try { localStorage.setItem('files-favorites', JSON.stringify(next)); } catch { /* ignore */ }
  },

  addRecentFile: (name: string, id: string) => {
    const { recentFiles } = get();
    const entry = { name, id, timestamp: Date.now() };
    const filtered = recentFiles.filter(r => r.id !== id);
    const next = [entry, ...filtered].slice(0, 20);
    set({ recentFiles: next });
    try { localStorage.setItem('files-recent-files', JSON.stringify(next)); } catch { /* ignore */ }
  },

  undoLastAction: async () => {
    const { client, lastAction, refresh } = get();
    if (!client || !lastAction) return;

    for (const entry of lastAction.entries) {
      await client.updateFileNode(entry.id, entry.from);
    }
    set({ lastAction: null });
    await refresh();
  },
}));
