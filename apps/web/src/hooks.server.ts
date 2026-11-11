import type { Handle } from '@sveltejs/kit/hooks';
import { attr, petPreview, shortNear } from '#lib/server/preview';

/**
 * Link-preview tags, put into the HTML the server sends.
 *
 * The app renders in the browser (`ssr = false`), so the page a crawler gets
 * is an empty shell — and Telegram, X and Discord read `og:` tags from that
 * shell without running any JavaScript. This writes them in on the way out.
 * Only the tags are server-made; the page itself is untouched.
 */

type Preview = { title: string; description: string; image: string };

const SITE_DESCRIPTION =
  'On-chain pets on NEAR that live on your desktop and react to every tool call your coding agent makes. Mint one, raise it, battle, trade.';

const PAGES: Record<string, { title: string; description: string }> = {
  '/': { title: 'JOYGOTCHI — pets on chain and on your desktop', description: SITE_DESCRIPTION },
  '/download': {
    title: 'JOYGOTCHI Desktop',
    description:
      'A small window above your editor. Your pet idles there and reacts to your coding agent. macOS, Windows and Linux.'
  },
  '/create': {
    title: 'Create a species · JOYGOTCHI',
    description: 'Recolour a dragon, name it and register it on NEAR. You earn 1% of every mint of it.'
  }
};

async function previewFor(url: URL): Promise<Preview> {
  const site: Preview = {
    title: PAGES[url.pathname]?.title ?? 'JOYGOTCHI',
    description: PAGES[url.pathname]?.description ?? SITE_DESCRIPTION,
    image: `${url.origin}/api/og/site.png`
  };

  const match = /^\/pets\/([a-z0-9-]+)\/?$/.exec(url.pathname);
  if (!match) return site;

  const pet = await petPreview(match[1]!).catch(() => null);
  if (!pet) return site;

  const sale = pet.forSale ? ` For sale at ${shortNear(pet.forSale)} NEAR.` : '';
  return {
    title: `${pet.name} · ${pet.rarity} ${pet.species} · JOYGOTCHI`,
    description: `Pet #${pet.petId}, level ${pet.level}, phase ${pet.phase}.${sale} Install it on your desktop and it reacts to your coding agent.`,
    image: `${url.origin}/api/og/${pet.slug}.png`
  };
}

function tags(preview: Preview, url: URL): string {
  const t = attr(preview.title);
  const d = attr(preview.description);
  const i = attr(preview.image);
  return [
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="JOYGOTCHI" />`,
    `<meta property="og:url" content="${attr(url.origin + url.pathname)}" />`,
    `<meta property="og:title" content="${t}" />`,
    `<meta property="og:description" content="${d}" />`,
    `<meta property="og:image" content="${i}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${t}" />`,
    `<meta name="twitter:description" content="${d}" />`,
    `<meta name="twitter:image" content="${i}" />`
  ].join('\n    ');
}

export const handle: Handle = async ({ event, resolve }) => {
  const { url, request } = event;
  const isPage =
    request.method === 'GET' &&
    !url.pathname.startsWith('/api/') &&
    (request.headers.get('accept') ?? '').includes('text/html');
  if (!isPage) return resolve(event);

  const preview = await previewFor(url);
  return resolve(event, {
    transformPageChunk: ({ html }) => html.replace('</head>', `    ${tags(preview, url)}\n  </head>`)
  });
};
