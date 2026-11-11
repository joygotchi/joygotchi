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
 * 2. Reading it needs a GitHub token with `read:packages`, and no setting on
 *    our side removes that. This was first written down as a consequence of
 *    the repository being private, which was a guess. It has since been
 *    measured: with the repository public *and* the package itself set to
 *    public, an anonymous `GET https://npm.pkg.github.com/@joygotchi%2fjoygotchi`
 *    still answers `401 authentication token not provided`, and an `npx`
 *    run with an empty user config fails the same way. GitHub Packages
 *    authenticates reads of public npm packages.
 *
 * Both steps are one-time and both are `npm config set`, so nobody has to edit
 * an `.npmrc` by hand.
 *
 * It is also why `npx @joygotchi/joygotchi` on a fresh machine fails with a
 * 404 from npmjs rather than anything mentioning GitHub: npm looked the scope
 * up where it was told to, and nobody told it. Publishing to npmjs would end
 * both steps, and is the open question in the roadmap.
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
