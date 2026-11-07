import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ stored: null as null | { creditsPerUsd: number }, cto: false }));
vi.mock('./service.js', () => ({ billingService: { stored: async () => state.stored } }));
const findById = vi.hoisted(() => vi.fn(async (id: string) => ({ id, isCto: state.cto })));
vi.mock('../users/repository.js', () => ({ userRepository: { findById } }));

const { isBillable, sessionBillable } = await import('./billable.js');

beforeEach(() => {
  state.stored = null;
  state.cto = false;
  findById.mockClear();
});

describe('isBillable', () => {
  it('compte tout sans facturation en crédits', () => {
    expect(isBillable({ creditMode: false, cellAccount: false, cto: false })).toBe(true);
  });
  it('en crédits : compte de la cellule ou CTO seulement', () => {
    expect(isBillable({ creditMode: true, cellAccount: true, cto: false })).toBe(true);
    expect(isBillable({ creditMode: true, cellAccount: false, cto: true })).toBe(true);
    expect(isBillable({ creditMode: true, cellAccount: false, cto: false })).toBe(false);
  });
});

describe('sessionBillable', () => {
  it('instance sans facturation : tout compte', async () => {
    expect(await sessionBillable('u1', false)).toBe(true);
  });
  it('cellule en crédits : propre compte d’une personne non compté, d’un CTO compté', async () => {
    state.stored = { creditsPerUsd: 100 };
    expect(await sessionBillable('u1', false)).toBe(false);
    state.cto = true;
    expect(await sessionBillable('u1', false)).toBe(true);
  });
  it('compte de la cellule : toujours compté, sans relire la personne', async () => {
    state.stored = { creditsPerUsd: 100 };
    expect(await sessionBillable('u1', true)).toBe(true);
    expect(findById).not.toHaveBeenCalled();
  });
  it('taux nul : pas de mode crédits', async () => {
    state.stored = { creditsPerUsd: 0 };
    expect(await sessionBillable('u1', false)).toBe(true);
  });
});
