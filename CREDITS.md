# Credits

## Armagetron Advanced

The game this port is based on: Copyright (C) Manuel Moos and the Armagetron
Advanced development team; portions (C) 1998 David K. McAllister.
Licensed under the GNU General Public License, version 2 or later.
<https://www.armagetronad.net/> · <https://github.com/ArmagetronAd/armagetronad>

Development team (from upstream's AUTHORS): Dave Fancella (Lucifer), epsy,
Fred (guru3, Tank Program), Jochen Darley (yarrt), Luke-Jr, Daniel Harple,
Mathias Plichta (wrtlprnft), Manuel Moos (z-man). Honored former members:
Alex E. Kelly, subby, Kurt Johnson, Peter (klaxnek), Philippe Villeneuve,
fman23. Many more contributors are listed in [AUTHORS.upstream](AUTHORS.upstream).

## Assets

All copied unchanged from upstream (GPL-2.0-or-later):

| In this repository | Upstream | By |
|---|---|---|
| `media/fortresswalk.ogg`, `media/doIknowyou.ogg`, `media/titletrack.ogg` | `music/` | Dave Fancella (2006) |
| `media/when.ogg` | `music/when.ogg` | the Armagetron Advanced team |
| `server/web/snd/*.ogg` | `sound/` | the Armagetron Advanced team |
| `server/web/fonts/Armagetronad.ttf` | `textures/Armagetronad.ttf` (source: `textures/armagetronad.sfd`) | Dave Fancella, with glyphs by Luke-Jr and wrtlprnft |
| `server/web/tex/title.jpg` | `textures/title.jpg` | Edd Keefe |
| `server/web/tex/clock.png` | `resource/binary/wrtlprnft/benboisclock-1.aatex.png` | wrtlprnft |
| `server/web/tex/gauge.png`, `gauge_filled.png` | `resource/binary/wrtlprnft/gauge_horizontal-1.aatex.png`, `gauge_horizontal_filled-1.aatex.png` | wrtlprnft |
| `server/web/tex/map_floor.png` | `resource/binary/wrtlprnft/floor-1.aatex.png` | wrtlprnft |
| `server/web/tex/*.png` (the others) | `textures/` | the Armagetron Advanced team |
| `server/web/js/models.js` | `models/cycle_*.mod` (in `tools/models/`, converted by `tools/models.py`) | the Armagetron Advanced team |

The font's source file (`textures/armagetronad.sfd`, 5 MB) is not copied here; it
is in the upstream repository at commit `2186c8c1`.

## The port

Copyright (C) 2026 Andreas Nägeli. The servers run on [GenHTTP](https://genhttp.dev/).
