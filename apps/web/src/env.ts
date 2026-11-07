import { defineEnvVars } from '@sveltejs/kit/env';

const withDefault = (fallback: string) => (value: string | undefined) =>
  value && value.trim().length > 0 ? value.trim() : fallback;

const optional = () => (value: string | undefined) => (value ?? '').trim();

export const variables = defineEnvVars({
  PUBLIC_NEAR_NETWORK: {
    public: true,
    schema: (value: string | undefined) => {
      const network = value?.trim() || 'testnet';
      if (network !== 'mainnet' && network !== 'testnet') {
        throw new Error('must be "mainnet" or "testnet"');
      }
      return network as 'mainnet' | 'testnet';
    },
    description: 'Which NEAR network the app reads and writes. Testnet while 1Click is not wired.'
  },
  PUBLIC_NEAR_RPC_URL: {
    public: true,
    schema: optional(),
    description:
      'JSON-RPC endpoint for view calls. Empty picks FastNEAR by network. It has to send ' +
      'CORS headers: the browser reads contract state directly, and rpc.*.near.org refuses ' +
      'cross-origin requests.'
  },
  PUBLIC_GAME_CONTRACT: {
    public: true,
    schema: withDefault('jg-game-5656.testnet'),
    description: 'The game contract: pets as NEP-171 tokens, minting, levels, battles.'
  },
  PUBLIC_STAKE_CONTRACT: {
    public: true,
    schema: withDefault('jg-stake-5656.testnet'),
    description: 'The AI-credit ledger: stake pets, earn credits, spend them on NEAR AI.'
  },
  PUBLIC_MINT_PRICE_NEAR: {
    public: true,
    schema: withDefault('2'),
    description: 'What one pet costs, in NEAR. Must match the contract, which charges its own.'
  },

  NEAR_AI_API_KEY: {
    schema: optional(),
    description:
      'NEAR AI Cloud key. Empty disables the AI endpoints, which then say so instead of ' +
      'failing: the gallery and installs work without it.'
  },
  NEAR_AI_BASE_URL: {
    schema: withDefault('https://cloud-api.near.ai/v1'),
    description: 'NEAR AI Cloud base URL.'
  },
  NEAR_AI_MODEL: {
    schema: withDefault('google/gemini-3.1-flash-lite'),
    description:
      'Model used for pet reactions and chat. Must be an exact id from the NEAR AI catalogue; ' +
      'a name that is close but not exact fails at call time, not at startup. Prefer a model ' +
      'that does not reason: a pet says one line, and a reasoning model spends hundreds of ' +
      'tokens deciding what that line should be before writing it.'
  }
});
