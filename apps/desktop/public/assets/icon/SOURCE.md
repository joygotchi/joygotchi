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

| `tonic.png` | 7, 8 | A green flask. Red would have clashed with the shop's potion, and it wore holy water before. |
| `lens.png` | 18, 4 | A scrying orb, for the item that doubles what a meal is worth. It wore a plate of food. |
| `charm.png` | 7, 4 | An amulet. It wore a star, which is also what the charm protects — two stars meaning two things. |

Added when every action tile moved onto this sheet, so the grid stops
mixing it with the older one-off drawings:

| File | Sheet row, column | Why this one |
| --- | --- | --- |
| `feed.png` | 30, 5 | A roast leg. A meal, read at a glance. |
| `revive.png` | 41, 13 | A glowing cross: coming back. It wore a bottle of holy water. |
| `faucet.png` | 7, 10 | A blue water bottle, for the free drip of credits. |
| `mine.png` | 96, 0 | A gold pickaxe — digging up credits. |
| `battle.png` | 45, 0 | Crossed swords. |
| `lab.png` | 7, 12 | An anvil, for a pet put to work. A brain was tried and read as bread. |
| `bag.png` | 9, 13 | A sack: what the pet carries. The sheet has no backpack. |
| `talk.png` | 0, 6 | A quill. The sheet's speech bubble is three dots, too small to read at 40px. |

A first pass used a market stall, a coin pouch and a green up-arrow. They were
legible but wrong in register — the stall and the shop's potion were two shop
fronts for different things, and the arrow belonged to a toolbar.

The sheet is 512×4384, sixteen 32-pixel columns. Position (row, column) maps
to the crop `(col*32, row*32, col*32+32, row*32+32)`.
