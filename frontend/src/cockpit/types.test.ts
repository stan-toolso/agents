import { describe, expect, it } from 'vitest';
import { addBlock, blocksOf, moveBlock, patchBlock, removeBlock, setBlockRegion, type Layout } from './types';

const layout: Layout = {
  v: 1,
  blocks: [
    { id: 't1', kind: 'builtin', widget: 'tile.requests', region: 'tiles' },
    { id: 'm1', kind: 'builtin', widget: 'list.todo', region: 'main' },
    { id: 'm2', kind: 'builtin', widget: 'list.attention_tasks', region: 'main' },
    { id: 's1', kind: 'builtin', widget: 'list.activity', region: 'side' },
  ],
};
const ids = (l: Layout, region: Parameters<typeof blocksOf>[1]) => blocksOf(l, region).map((b) => b.id);

describe('édition locale d’un agencement', () => {
  it('monte et descend un bloc dans sa région seulement, sans toucher aux autres régions', () => {
    const up = moveBlock(layout, 'm2', -1);
    expect(ids(up, 'main')).toEqual(['m2', 'm1']);
    expect(ids(up, 'tiles')).toEqual(['t1']);
    expect(moveBlock(layout, 'm1', -1)).toBe(layout);
    expect(moveBlock(layout, 'zz', 1)).toBe(layout);
  });
  it('change de région en passant en fin de la nouvelle région', () => {
    const moved = setBlockRegion(layout, 'm1', 'side');
    expect(ids(moved, 'main')).toEqual(['m2']);
    expect(ids(moved, 'side')).toEqual(['s1', 'm1']);
    expect(setBlockRegion(layout, 'm1', 'main')).toBe(layout);
  });
  it('ajoute en fin de région, retire, règle', () => {
    const added = addBlock(layout, { id: 'n', kind: 'builtin', widget: 'text', region: 'main' });
    expect(ids(added, 'main')).toEqual(['m1', 'm2', 'n']);
    expect(ids(removeBlock(added, 'm1'), 'main')).toEqual(['m2', 'n']);
    const set = patchBlock(layout, 'm2', { title: 'Urgent', params: { limit: 3 } });
    expect(set.blocks[2]).toMatchObject({ id: 'm2', title: 'Urgent', params: { limit: 3 } });
    expect(layout.blocks[2]).not.toHaveProperty('title');
  });
});
