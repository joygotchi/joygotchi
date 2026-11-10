import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, decideMeals, type AutoFeedAccount, type OwnedPet } from './decide.ts';

const PRICE = DEFAULT_RULES.price;

const account = (id: string, available: number): AutoFeedAccount => ({
  account_id: id,
  budget: String(available),
  spent: '0',
  available: String(available),
  credit_balance: String(available),
  window: '1'
});

const pet = (pet_id: number, owner_id: string, secondsLeft: number): OwnedPet => ({
  pet_id,
  owner_id,
  seconds_until_starving: String(secondsLeft)
});

const from = (pets: OwnedPet[]) => (id: string) => pets.filter((p) => p.owner_id === id);

describe('decideMeals', () => {
  it('feeds a pet that is running low', () => {
    const meals = decideMeals([account('a.near', PRICE)], from([pet(1, 'a.near', 3_600)]));
    expect(meals).toEqual([{ accountId: 'a.near', petId: 1, secondsLeft: 3_600 }]);
  });

  it('leaves a well-fed pet alone', () => {
    // Banked food is capped at seven days and the overflow is thrown away,
    // so an early meal is mostly spent on nothing.
    const meals = decideMeals([account('a.near', PRICE * 10)], from([pet(1, 'a.near', 5 * 86_400)]));
    expect(meals).toEqual([]);
  });

  it('will not feed a pet that has already starved', () => {
    // `feed_from_stake` refuses it, so this would spend gas to be told no.
    // Coming back takes a revival item paid in NEAR, which is the owner's
    // decision and not a thing to make on their behalf.
    const meals = decideMeals([account('a.near', PRICE * 5)], from([pet(1, 'a.near', 0)]));
    expect(meals).toEqual([]);
  });

  it('stops at the budget, however many pets are hungry', () => {
    const meals = decideMeals(
      [account('a.near', PRICE * 2)],
      from([pet(1, 'a.near', 100), pet(2, 'a.near', 200), pet(3, 'a.near', 300)])
    );
    expect(meals).toHaveLength(2);
  });

  it('spends what is left on the hungriest', () => {
    // If the budget runs out it has to run out on the pets with the most
    // time left, or a short budget kills the pet it was meant to save.
    const meals = decideMeals(
      [account('a.near', PRICE)],
      from([pet(1, 'a.near', 10_000), pet(2, 'a.near', 60)])
    );
    expect(meals.map((m) => m.petId)).toEqual([2]);
  });

  it('skips an account that cannot afford one meal', () => {
    const meals = decideMeals([account('a.near', PRICE - 1)], from([pet(1, 'a.near', 60)]));
    expect(meals).toEqual([]);
  });

  it('never feeds one account out of another budget', () => {
    // The whole safety of this is that it spends only what each account set
    // aside, so pets are matched to their own owner and nobody else's.
    const pets = [pet(1, 'a.near', 60), pet(2, 'b.near', 60)];
    const meals = decideMeals([account('a.near', PRICE * 5)], from(pets));
    expect(meals).toEqual([{ accountId: 'a.near', petId: 1, secondsLeft: 60 }]);
  });

  it('ignores a pet the view wrongly attributed', () => {
    // Defensive: `petsOf` is a network answer, and one mismatched row would
    // otherwise have one account paying for another's pet.
    const meals = decideMeals(
      [account('a.near', PRICE * 5)],
      () => [pet(9, 'someone-else.near', 60)]
    );
    expect(meals).toEqual([]);
  });

  it('survives a field the chain left out', () => {
    const meals = decideMeals(
      [{ ...account('a.near', PRICE), available: undefined as unknown as string }],
      from([pet(1, 'a.near', 60)])
    );
    expect(meals).toEqual([]);
  });

  it('handles several accounts in one round', () => {
    const pets = [pet(1, 'a.near', 60), pet(2, 'b.near', 120)];
    const meals = decideMeals([account('a.near', PRICE), account('b.near', PRICE)], from(pets));
    expect(meals.map((m) => m.accountId)).toEqual(['a.near', 'b.near']);
  });
});
