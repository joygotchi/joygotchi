# Submitted species art

One folder per species, named by its id, holding its sprite atlases:

    species/<id>/1.png    phase 1, an 8x9 atlas, 1536x1872
    species/<id>/2.png    optional
    species/<id>/3.png    optional

These are served at `https://joygotchi.vercel.app/species/<id>/<phase>.png`,
which is the url the species carries on chain. That is why they are committed
rather than uploaded: this project has no storage, and a url in NFT metadata
has to keep working for as long as the pet exists. A file in a public
repository, served by a CDN, outlives a bucket somebody has to keep paying
for.

It also means adding a species is a pull request, which is the review step —
the same shape petdex uses, where a submission waits in a queue before anyone
can install it. The difference is that nothing here can be taken down by us
after the fact: the species is registered on chain by its creator, with their
own NEAR, and this repository only serves the pixels.

`joygotchi submit <folder> --into <checkout>` puts the files in the right
place and prints the `create_species` call that registers them.

## reference

The first species submitted this way, and it doubles as the worked example:
open `1.png` and you can see what each of the nine rows is meant to contain.
It is built from this game's own green dragon by `make-sheet.py`, one real
motion per row — the jump has an arc, the two run rows go opposite ways and
one is mirrored, the failed row shakes — rather than the same drawing nudged
eight times.

Three phases, so it also shows what evolving looks like: the sheets come from
the dragon's three drawings.
