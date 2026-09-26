// Armagetron Advanced, browser port. Copyright (C) 2026 Andreas Nägeli.
// Based on Armagetron Advanced, Copyright (C) Manuel Moos and the Armagetron Advanced team.
// GNU GPL version 2 or later, see COPYING.txt. Source: https://github.com/Kaliumhexacyanoferrat/armagetron-advanced-browser

// Armagetron Advanced in the browser: light cycles on a grid, many servers on
// one lambda. Anybody can start a server from the front page and runs it as
// its administrator; everybody else joins from the list or with a link.
//
//   GET  ./             the game, a single page application in web/
//   WS   play           the socket every page opens: JSON messages both ways, and
//                       small binary frames for the game itself (Protocol.cs)
//   GET  api/servers    the running servers, for the front page
//   GET  media/...      the music, kept in the workspace (too big for assets)
//
// The files:
//
//   Lobby.cs     every server (room) and the one loop that runs them
//   Hub.cs       the websocket handler: hands messages to the lobby or a room
//   Room.cs      a server: its players, joining and leaving
//   Game.cs      rounds, the simulation, lag compensation, scores
//   Chat.cs      chat, commands, spam protection, administration
//   Bot.cs       the AI players
//   Sim.cs       the light cycle rules (a port of web/js/sim.js)
//   Client.cs    one connected browser and its send queue
//   Protocol.cs  the messages
//   Util.cs      JSON and name helpers
//   web/         the page, its scripts, the original textures and sounds

void Log(string line) => Console.WriteLine(line);

var lobby = new Lobby(Log);

var hub = new Hub(lobby);

lobby.EverySecond = hub.Sweep;

var api = Inline.Create()
                .Get("servers", () => new ServerList(lobby.Top, lobby.Count, hub.Online));

var media = Workspace.Exists("media/titletrack.ogg") ? Workspace.Files("media") : null;

var layout = Layout.Create()
                   .Add("play", Websocket.Reactive().Handler(hub))
                   .Add("api", api);

if (media != null)
{
    layout.Add("media", media);
}

return layout.Add(Assets.App("web"));
