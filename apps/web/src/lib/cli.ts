/**
 * How the CLI is installed, in one place.
 *
 * The package lives on GitHub Packages rather than npmjs, which costs two
 * things worth writing down rather than discovering:
 *
 * 1. npm resolves a scoped name against registry.npmjs.org unless told
 *    otherwise, so every machine needs the scope pointed at GitHub once. This
 *    is not a visibility setting and making the package public does not
 *    remove it.
 * 2. While the repository is private the package is too, so reading it needs a
 *    GitHub token with `read:packages`.
 *
 * Both steps are one-time and both are `npm config set`, so nobody has to edit
 * an `.npmrc` by hand.
 */

export const CLI_PACKAGE = '@joygotchi/joygotchi';

export const CLI_REGISTRY = 'https://npm.pkg.github.com';

/** Point the scope at GitHub Packages. Once per machine. */
export const SETUP_REGISTRY = `npm config set ${CLI_PACKAGE.split('/')[0]}:registry ${CLI_REGISTRY}`;

/** Hand npm a token to read with. Once per machine, while the package is private. */
export const SETUP_TOKEN = `npm config set //npm.pkg.github.com/:_authToken <your-github-token>`;

/** The command that actually installs a pet. */
export const installCommand = (code: string) => `npx ${CLI_PACKAGE} install ${code}`;

/** Where to make the token. */
export const TOKEN_URL = 'https://github.com/settings/tokens';
