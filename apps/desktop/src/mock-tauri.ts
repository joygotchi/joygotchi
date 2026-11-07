/**
 * Run the window's UI in an ordinary browser.
 *
 * The frontend is a Svelte app on a Vite port; everything that makes it an
 * app — the pet index, the keychain, the window sizing — arrives through
 * Tauri's `invoke`, which does not exist outside the shell. So layout and flow
 * bugs could only be found by building Rust, launching the window, and
 * clicking around in it.
 *
 * With this, `pnpm dev` in `apps/desktop` serves something you can open at
 * <http://localhost:5275> and look at. It answers with fixtures, so it proves
 * nothing about the chain — it is for the class of bug that has actually been
 * costing time here: a panel that reloads forever, a button that was never
 * rendered, a control nobody could find.
 *
 * Installed only when Tauri is absent and only in dev, so it can never reach
 * a build.
 */
type Handler = (args: Record<string, unknown>) => unknown;

const PETS = [
  // In id order, the way `installed_pets` returns them — `load` treats the
  // last as the newest.
  {
    format: 'joygotchi/1',
    slug: 'fafnir-5',
    displayName: 'FAFNIR',
    petId: 5,
    installCode: 'jg1_06m7ha0a1580',
    kind: 'greendragon',
    rarity: 'epic',
    level: 0,
    star: 0,
    chain: {
      network: 'testnet',
      contract: 'jg-game-5656.testnet',
      owner: 'jg-p2-72362.testnet'
    },
    states: { idle: 'greendragon/1.gif' },
    directory: '/mock/fafnir-5'
  },
  {
    format: 'joygotchi/1',
    slug: 'kuro-6',
    displayName: 'KURO',
    petId: 6,
    installCode: 'jg1_04yg63ewm0x0',
    kind: 'greendragon',
    rarity: 'rare',
    level: 0,
    star: 0,
    chain: {
      network: 'testnet',
      contract: 'jg-game-5656.testnet',
      owner: 'kurodenjiro2.testnet'
    },
    states: { idle: 'greendragon/2.gif' },
    directory: '/mock/kuro-6'
  },
  {
    // A pet that really exists on jg-game-5656.testnet, so the battle watcher
    // has something to watch: the fixtures drive the window, but the watcher
    // polls the chain by this id.
    format: 'joygotchi/1',
    slug: 'sparring-7',
    displayName: 'SPARRING',
    petId: 7,
    installCode: 'jg1_mock00000007',
    kind: 'blackdragon',
    rarity: 'rare',
    level: 0,
    star: 0,
    chain: {
      network: 'testnet',
      contract: 'jg-game-5656.testnet',
      owner: 'jg-p2-72362.testnet'
    },
    states: { idle: 'blackdragon/1.gif' },
    directory: '/mock/sparring-7'
  },
  {
    // Staked and carrying a shield on testnet, which is the only way to look
    // at the accessory and the weight bonus without buying one each time.
    format: 'joygotchi/1',
    slug: 'ringer-8',
    displayName: 'RINGER',
    petId: 8,
    installCode: 'jg1_mock00000008',
    kind: 'greendragon',
    rarity: 'rare',
    level: 0,
    star: 0,
    chain: {
      network: 'testnet',
      contract: 'jg-game-5656.testnet',
      owner: 'jg-p3-72362.testnet'
    },
    states: { idle: 'greendragon/1.gif' },
    directory: '/mock/ringer-8'
  }
];

/**
 * A session for the pet's owner, so the panel renders its real controls.
 *
 * Which account is signing decides most of what the panel draws: a pet that
 * is not yours hides every tile. Overridable, because checking that half of
 * the UI otherwise means editing this file and putting it back.
 *
 *     localStorage.setItem('joygotchi:mock-account', 'jg-p2-72362.testnet')
 */
const SESSION = {
  accountId: localStorage.getItem('joygotchi:mock-account') ?? 'kurodenjiro2.testnet',
  publicKey: 'ed25519:mock',
  contractId: 'jg-stake-5656.testnet',
  gameContractId: 'jg-game-5656.testnet',
  gamePublicKey: 'ed25519:mockgame',
  methodNames: [
    'claim_credits',
    'spend_credits',
    'buy_credit_item',
    'use_item',
    'claim_mining',
    'claim_faucet'
  ],
  expiresAt: Math.floor(Date.now() / 1000) + 30 * 86_400
};

const HANDLERS: Record<string, Handler> = {
  list_pets: () => PETS,
  pets_directory: () => '/mock/.joygotchi/pets',
  hook_port: () => 7777,
  get_session: () => SESSION,
  has_session_key: () => false,
  sign_bytes: () => {
    throw new Error('[mock] signing needs the real app');
  },
  wallet_callback_url: () => 'http://127.0.0.1:7777/wallet-callback',
  save_session: () => null,
  clear_session: () => null,
  set_click_through: () => null,
  set_panel_open: () => null,
  open_url: ({ url }) => {
    console.info('[mock] would open', url);
    return null;
  },
  quit: () => console.info('[mock] would quit'),

  // Tauri's event plugin. Nothing emits here, so listening is a no-op that
  // still has to hand back an id for `unlisten` to call.
  'plugin:event|listen': () => 1,
  'plugin:event|unlisten': () => null
};

export function installTauriMock() {
  if (!import.meta.env.DEV) return;
  if ('__TAURI_INTERNALS__' in window) return;

  console.info('[mock] Tauri is absent — serving fixtures so the UI can be looked at');

  // The real window is transparent over whatever is behind it; a browser tab
  // has nothing behind it, so the whole UI would be dark text on white.
  document.documentElement.style.background = '#1b1f26';

  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    invoke: (command: string, args: Record<string, unknown> = {}) => {
      const handler = HANDLERS[command];
      if (!handler) {
        console.warn('[mock] no handler for', command);
        return Promise.resolve(null);
      }
      return Promise.resolve(handler(args));
    },
    // The window's art is a file:// path through `convertFileSrc`; in a
    // browser the same drawings are served by Vite from `public/`. Both path
    // segments matter — `greendragon/1.gif`, not `1.gif`.
    convertFileSrc: (path: string) => `/assets/animation/${path.split('/').slice(-2).join('/')}`,
    transformCallback: (callback: unknown) => callback,
    unregisterCallback: () => {}
  };
}
