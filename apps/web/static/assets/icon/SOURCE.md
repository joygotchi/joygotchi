# Where these came from

Raven Fantasy Icons, the free pack, by Clockwork Raven — cut from its
`32x32` spritesheet at the grid positions below. Kept here so the next person
can take a different one from the same sheet without hunting for it.

| File | Sheet row, column | Why this one |
| --- | --- | --- |
| `market.png` | 7, 11 | Balance scales: a trade between two players, which a shop front is not. |
| `shop.png` | 17, 9 | A potion. The shop sells tonics, wards and lenses, and used to wear a water bottle. |
| `claim.png` | 8, 2 | A gold coin — collecting what you have already earned, not spending it. |
| `style.png` | 7, 7 | A hand mirror. The crown it replaced said rank, and this is about looks. |
| `evolve.png` | 1, 9 | A crystal cluster: growing into something else. An up-arrow read as a UI control rather than a change to the animal. |

A first pass used a market stall, a coin pouch and a green up-arrow. They were
legible but wrong in register — the stall and the shop's potion were two shop
fronts for different things, and the arrow belonged to a toolbar.

The sheet is 512×4384, sixteen 32-pixel columns. Position (row, column) maps
to the crop `(col*32, row*32, col*32+32, row*32+32)`.
