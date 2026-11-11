import { describe, expect, it } from 'vitest';
import { arrange } from './gallery';
import type { GalleryPet } from './pets';

const pet = (pet_id: number, over: Partial<GalleryPet> = {}) =>
  ({
    pet_id,
    name: `PET${pet_id}`,
    kind: 'greendragon',
    level: 0,
    rarity: 'common',
    listing: null,
    ...over
  }) as unknown as GalleryPet;

const listed = (price: string) => ({ pet_id: 0, seller_id: 's', price, listed_at: '0' });

const PETS = [
  pet(1, { name: 'SMAUG', level: 3, rarity: 'rare' }),
  pet(2, { name: 'KURO', kind: 'blackdragon', rarity: 'Legendary' }),
  pet(3, { name: 'RINGER', level: 1, listing: listed('2000000000000000000000000') }),
  pet(4, { name: 'SMAUGLING', listing: listed('500000000000000000000000') })
];
const ids = (pets: GalleryPet[]) => pets.map((one) => Number(one.pet_id));
const all = { filter: 'all', query: '', sort: 'newest' as const };

describe('arrange', () => {
  it('shows newest first by default', () => {
    expect(ids(arrange(PETS, all))).toEqual([4, 3, 2, 1]);
  });

  it('finds a pet by name or by number', () => {
    expect(ids(arrange(PETS, { ...all, query: 'smaug' }))).toEqual([4, 1]);
    expect(ids(arrange(PETS, { ...all, query: '#2' }))).toEqual([2]);
    expect(ids(arrange(PETS, { ...all, query: '3' }))).toEqual([3]);
  });

  it('filters by species and by sale', () => {
    expect(ids(arrange(PETS, { ...all, filter: 'blackdragon' }))).toEqual([2]);
    expect(ids(arrange(PETS, { ...all, filter: 'sale' }))).toEqual([4, 3]);
  });

  it('sorts by level, then rarity regardless of case', () => {
    expect(ids(arrange(PETS, { ...all, sort: 'level' }))).toEqual([1, 3, 4, 2]);
    expect(ids(arrange(PETS, { ...all, sort: 'rarity' }))[0]).toBe(2);
  });

  it('puts the cheapest pet for sale first, then everything else', () => {
    expect(ids(arrange(PETS, { ...all, sort: 'price' }))).toEqual([4, 3, 2, 1]);
  });
});
