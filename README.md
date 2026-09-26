# Armagetron Advanced in the browser

An unofficial browser port of [Armagetron Advanced](https://www.armagetronad.net/),
the multiplayer light cycle game. Play it at
<https://www.genhttp.dev/lambda/armagetron/>: start a server of your own, send the
link to your friends, and race them (and the AI players) into the wall.

The game rules, numbers, camera, cockpit and look follow the original's source
code; its textures, sounds, font, cycle models and music are included unchanged.

## How it is built

- `server/` is a [GenHTTP](https://genhttp.dev/) lambda in C#: `lambda.cs` is the
  entry point, the other files hold the lobby, the rooms, the simulation, the AI
  players, chat and administration. `server/web/` is the browser client (WebGL 2,
  plain JavaScript modules, no build step).
- The simulation runs in fixed steps of 1/60 s on both sides: `server/Sim.cs` is a
  line-by-line port of `server/web/js/sim.js`. The browser predicts its own cycle
  and the server compensates for lag by rewinding a cycle to where a turn was made.
- The rooms are spread over a few game loops (`Lobby.Loops`, four on the lambda;
  about one per core on a machine of your own); the server indexes the walls
  so the collision tests stay cheap late in a round.
- The frequent game messages (syncs, turns, deaths, brakes) are small binary
  frames (`Wire` in `server/Protocol.cs`, read in `server/web/js/net.js`); the
  rest is JSON.

## Working on it

    tools/local.py                  build and run the lambda locally (needs .NET)
    node tests/sim.test.mjs         checks of the shared rules
    node tests/ws.test.mjs [url]    a scripted session against a running server
    node tests/robot.mjs [url] [lag ms] [seconds]
                                    a headless player that reports deaths its own
                                    prediction did not see coming
    tools/deploy.py "what changed"  push server/ as a new lambda version
    tools/models.py                 convert tools/models/*.mod into web/js/models.js

## License

This program is free software; you can redistribute it and/or modify it under the
terms of the GNU General Public License as published by the Free Software
Foundation; either version 2 of the License, or (at your option) any later
version. It is distributed WITHOUT ANY WARRANTY; see [COPYING.txt](COPYING.txt).

It is a modified version of Armagetron Advanced, Copyright (C) Manuel Moos and the
Armagetron Advanced development team (upstream source:
<https://github.com/ArmagetronAd/armagetronad>, followed at commit `2186c8c1`).
The port was written in 2026 by Andreas Nägeli: a new C# server with lobby and
rooms, and a new WebGL client, both re-implementing the original's game logic;
the upstream assets are used as they are (a few cockpit images renamed, the
cycle models converted by `tools/models.py`). See [CREDITS.md](CREDITS.md) for
the authors and the origin of every asset, and [AUTHORS.upstream](AUTHORS.upstream)
for upstream's full list of contributors.
