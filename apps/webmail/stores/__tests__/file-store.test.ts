import { describe, it, expect, beforeEach } from 'vitest';
import { useFileStore } from '../file-store';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { FileNode } from '@/lib/jmap/types';

// Minimal in-memory FileNode backend that models the JMAP hierarchy via
// parentId links (the behaviour issue #379 asks for).
function makeMockClient(initial: FileNode[] = []) {
  let nodes: FileNode[] = initial.map(n => ({ ...n }));
  let seq = 0;
  const now = () => new Date().toISOString();

  const client = {
    getCapabilities: () => ({}),
    probeFileNodeSupport: async () => true,
    getFilesAccountId: () => 'acct',
    async listAllFileNodes() {
      return nodes.map(n => ({ ...n }));
    },
    async listFileNodes(parentId: string | null) {
      return nodes.filter(n => (n.parentId ?? null) === parentId).map(n => ({ ...n }));
    },
    async getFileNodes(ids: string[] | null) {
      return (ids === null ? nodes : nodes.filter(n => ids.includes(n.id))).map(n => ({ ...n }));
    },
    async createFileDirectory(name: string, parentId: string | null) {
      const node: FileNode = { id: `n${++seq}`, parentId, name, type: 'd', blobId: null, size: 0, created: now(), updated: now() };
      nodes.push(node);
      return { ...node };
    },
    async createFileNode(name: string, blobId: string, type: string, size: number, parentId: string | null) {
      const node: FileNode = { id: `n${++seq}`, parentId, name, type, blobId, size, created: now(), updated: now() };
      nodes.push(node);
      return { ...node };
    },
    async updateFileNode(id: string, updates: Partial<Pick<FileNode, 'name' | 'parentId'>>) {
      const node = nodes.find(n => n.id === id);
      if (node) Object.assign(node, updates);
    },
    async updateFileNodes(updates: Record<string, Partial<Pick<FileNode, 'name' | 'parentId'>>>) {
      const updated: string[] = [];
      for (const [id, patch] of Object.entries(updates)) {
        const node = nodes.find(n => n.id === id);
        if (node) { Object.assign(node, patch); updated.push(id); }
      }
      return { updated, notUpdated: {} as Record<string, string> };
    },
    async destroyFileNodes(ids: string[]) {
      // Emulate Stalwart's onDestroyRemoveChildren: removing a directory also
      // removes its whole subtree.
      const toRemove = new Set(ids);
      let grew = true;
      while (grew) {
        grew = false;
        for (const n of nodes) {
          if (n.parentId && toRemove.has(n.parentId) && !toRemove.has(n.id)) {
            toRemove.add(n.id);
            grew = true;
          }
        }
      }
      nodes = nodes.filter(n => !toRemove.has(n.id));
      return { destroyed: [...toRemove], notDestroyed: [] };
    },
    async copyFileNode(id: string, newName: string, parentId: string | null) {
      const original = nodes.find(n => n.id === id);
      if (!original) throw new Error('not found');
      return this.createFileNode(newName, original.blobId ?? '', original.type, original.size, parentId);
    },
    async uploadBlob(file: File) {
      return { blobId: `blob${++seq}`, type: file.type };
    },
    // test helper
    _nodes: () => nodes,
  };

  return client as unknown as IJMAPClient & { _nodes: () => FileNode[] };
}

const dir = (id: string, name: string, parentId: string | null): FileNode => ({
  id, parentId, name, type: 'd', blobId: null, size: 0, created: '', updated: '',
});
const file = (id: string, name: string, parentId: string | null): FileNode => ({
  id, parentId, name, type: 'text/plain', blobId: `b-${id}`, size: 10, created: '', updated: '',
});

describe('file-store hierarchy (issue #379)', () => {
  beforeEach(() => {
    useFileStore.setState({
      client: null,
      currentParentId: null,
      currentPath: '/',
      pathStack: [{ id: null, name: '' }],
      resources: [],
      selectedResources: new Set(),
      clipboard: null,
      lastAction: null,
    });
  });

  it('lists only root-level nodes at the root, not the whole tree flattened', async () => {
    // Stuff > Nonsense > Notes.md / Other.md (the exact shape from the issue)
    const client = makeMockClient([
      dir('stuff', 'Stuff', null),
      dir('nonsense', 'Nonsense', 'stuff'),
      file('notes', 'Notes.md', 'nonsense'),
      file('other', 'Other.md', 'nonsense'),
    ]);
    useFileStore.getState().initClient(client);

    await useFileStore.getState().navigate(null);
    const names = useFileStore.getState().resources.map(r => r.name);
    expect(names).toEqual(['Stuff']);
  });

  it('navigates into a folder via parentId and shows its direct children', async () => {
    const client = makeMockClient([
      dir('stuff', 'Stuff', null),
      dir('nonsense', 'Nonsense', 'stuff'),
      file('notes', 'Notes.md', 'nonsense'),
      file('other', 'Other.md', 'nonsense'),
    ]);
    useFileStore.getState().initClient(client);

    await useFileStore.getState().navigate('stuff', 'Stuff');
    expect(useFileStore.getState().resources.map(r => r.name)).toEqual(['Nonsense']);

    await useFileStore.getState().navigate('nonsense', 'Nonsense');
    expect(useFileStore.getState().resources.map(r => r.name).sort()).toEqual(['Notes.md', 'Other.md']);
  });

  it('creates a directory as a child node with a plain name (no path encoding)', async () => {
    const client = makeMockClient([dir('stuff', 'Stuff', null)]);
    useFileStore.getState().initClient(client);

    await useFileStore.getState().navigate('stuff', 'Stuff');
    await useFileStore.getState().createDirectory('Nonsense');

    const created = client._nodes().find(n => n.name === 'Nonsense');
    expect(created).toBeDefined();
    expect(created!.parentId).toBe('stuff');
    expect(created!.name).toBe('Nonsense'); // not "Stuff/Nonsense"
  });

  it('uploads a file into the current folder as a child node', async () => {
    const client = makeMockClient([dir('stuff', 'Stuff', null)]);
    useFileStore.getState().initClient(client);
    await useFileStore.getState().navigate('stuff', 'Stuff');

    await useFileStore.getState().uploadFile(new File(['hi'], 'Notes.md', { type: 'text/markdown' }));

    const uploaded = client._nodes().find(n => n.name === 'Notes.md');
    expect(uploaded!.parentId).toBe('stuff');
  });

  it('moves a node into a folder by reparenting (parentId), not by renaming', async () => {
    const client = makeMockClient([
      dir('b', 'B', null),
      file('f', 'f.txt', null),
    ]);
    useFileStore.getState().initClient(client);
    await useFileStore.getState().navigate(null);

    // Drag f.txt onto the B folder visible in the current (root) view.
    await useFileStore.getState().moveToFolder(['f.txt'], 'B');

    const moved = client._nodes().find(n => n.id === 'f')!;
    expect(moved.parentId).toBe('b');
    expect(moved.name).toBe('f.txt'); // name untouched
  });

  it('renames a node by changing only its name', async () => {
    const client = makeMockClient([dir('stuff', 'Stuff', null)]);
    useFileStore.getState().initClient(client);
    await useFileStore.getState().navigate(null);

    await useFileStore.getState().renameResource('Stuff', 'Things');
    const node = client._nodes().find(n => n.id === 'stuff')!;
    expect(node.name).toBe('Things');
    expect(node.parentId).toBeNull();
  });

  it('migrates legacy flat path-encoded nodes into the real hierarchy', async () => {
    const SEP = '∕';
    // Exactly the broken shape from issue #379: everything flat at the root
    // with the Unicode separator baked into the names.
    const client = makeMockClient([
      dir('stuff', 'Stuff', null),
      dir('nonsense', `Stuff${SEP}Nonsense`, null),
      file('notes', `Stuff${SEP}Nonsense${SEP}Notes.md`, null),
      file('other', `Stuff${SEP}Nonsense${SEP}Other.md`, null),
    ]);
    useFileStore.getState().initClient(client);

    const migrated = await useFileStore.getState().migrateLegacyFlatNodes();
    expect(migrated).toBe(true);

    const byId = Object.fromEntries(client._nodes().map(n => [n.id, n]));
    expect(byId.stuff).toMatchObject({ name: 'Stuff', parentId: null });
    expect(byId.nonsense).toMatchObject({ name: 'Nonsense', parentId: 'stuff' });
    expect(byId.notes).toMatchObject({ name: 'Notes.md', parentId: 'nonsense' });
    expect(byId.other).toMatchObject({ name: 'Other.md', parentId: 'nonsense' });

    // Browsing now reflects the real tree.
    await useFileStore.getState().navigate(null);
    expect(useFileStore.getState().resources.map(r => r.name)).toEqual(['Stuff']);
    await useFileStore.getState().navigate('nonsense', 'Nonsense');
    expect(useFileStore.getState().resources.map(r => r.name).sort()).toEqual(['Notes.md', 'Other.md']);
  });

  it('migrates legacy nodes that used a plain "/" separator (issue #379 data)', async () => {
    // A folder upload of a git checkout, stored flat with "/" in the names.
    const client = makeMockClient([
      dir('root', 'night-medieval-castle-lake', null),
      dir('branding', 'night-medieval-castle-lake/branding', null),
      dir('git', 'night-medieval-castle-lake/branding/.git', null),
      file('cfg', 'night-medieval-castle-lake/branding/.git/config', null),
      file('logo', 'kunden/logo.svg', null),
      dir('kunden', 'kunden', null),
    ]);
    useFileStore.getState().initClient(client);

    expect(await useFileStore.getState().migrateLegacyFlatNodes()).toBe(true);

    const byId = Object.fromEntries(client._nodes().map(n => [n.id, n]));
    expect(byId.root).toMatchObject({ name: 'night-medieval-castle-lake', parentId: null });
    expect(byId.branding).toMatchObject({ name: 'branding', parentId: 'root' });
    expect(byId.git).toMatchObject({ name: '.git', parentId: 'branding' });
    expect(byId.cfg).toMatchObject({ name: 'config', parentId: 'git' });
    expect(byId.logo).toMatchObject({ name: 'logo.svg', parentId: 'kunden' });

    await useFileStore.getState().navigate(null);
    expect(useFileStore.getState().resources.map(r => r.name).sort())
      .toEqual(['kunden', 'night-medieval-castle-lake']);
  });

  it('migration is a no-op when no legacy nodes exist', async () => {
    const client = makeMockClient([dir('a', 'A', null), file('f', 'f.txt', 'a')]);
    useFileStore.getState().initClient(client);
    expect(await useFileStore.getState().migrateLegacyFlatNodes()).toBe(false);
  });

  it('deletes a folder and the server removes its subtree', async () => {
    const client = makeMockClient([
      dir('stuff', 'Stuff', null),
      dir('nonsense', 'Nonsense', 'stuff'),
      file('notes', 'Notes.md', 'nonsense'),
    ]);
    useFileStore.getState().initClient(client);
    await useFileStore.getState().navigate(null);

    await useFileStore.getState().deleteResource('Stuff');
    expect(client._nodes()).toHaveLength(0);
  });
});
