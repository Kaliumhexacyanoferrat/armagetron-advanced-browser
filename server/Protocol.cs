// Messages the server sends, as JSON with a "t" for their type. Frequent ones
// (the cycle sync) are written by hand in Room.cs as compact arrays instead.
//
// Browser -> server (all have "t"):
//
//   hello   { name, r, g, b, cid }          who I am; sent first and whenever it changes
//   list                                    the open servers
//   create  { settings }                    start a server; answered with created
//   join    { room, token?, password? }     enter a server (token makes you its admin)
//   leave                                   back to the lobby
//   ping    { c }                           clock sync, answered with pong
//   turn    { d, n, x, y }                  turn left (-1) or right (1); n counts my turns,
//                                           x/y where I turned as far as I could tell
//   brake   { on }                          hold or release the brake
//   chat    { text }                        say something (or a /command)
//   spectate { on }                         sit out, or play again
//   admin   { cmd, id?, settings? }         owner only: kick, ban, unban, settings, restart, bots

public record Welcome(string Version, double Time, string T = "welcome");

public record Pong(double C, double S, string T = "pong");

public record Refused(string Reason, string Code = null, string T = "refused");

public record Joined(string Room, int You, bool Admin, string Token, object Settings, string Owner, string T = "joined");

public record Created(string Room, string Token, string T = "created");

public record RoomList(RoomInfo[] Rooms, string T = "rooms");

public record RoomInfo(string Id, string Name, string Owner, int Humans, int Bots, int Max, bool Locked, int Round, string Mode, int Spectators);

public record Chat(int From, string Name, string Text, string Kind, string T = "chat");

/// <summary>A line in the console, possibly with 0xRRGGBB colour codes.</summary>
public record Message(string Text, string T = "msg");

/// <summary>A big message in the middle of the screen.</summary>
public record Center(string Text, double Duration, string T = "center");

public record PlayerInfo(int Id, string Name, int R, int G, int B, int Score, bool Alive, int Ping, bool Bot, bool Admin, bool Spectator, int Kills, bool Chatting);

public record Players(PlayerInfo[] List, string T = "players");

public record Kicked(string Reason, string T = "kicked");

public record BanInfo(int Index, string Name, double Minutes);

public record BanList(BanInfo[] Bans, string T = "bans");

// the game itself

public record CycleInfo(int Id, string Name, int R, int G, int B, bool Alive, double DeathTime,
                        double X, double Y, int Dir, double V, double A, double LastTs, double Rubber, double BrakeRes, bool Braking,
                        double Dist, int Turns, double LastTurnTime, double Time, double[][] Points, double[][] Holes);

/// <summary>Everything about the current round, for a browser that joins or starts one.</summary>
public record Snapshot(int Round, string Phase, double Start, double Now, object Sim, double Size, CycleInfo[] Cycles, string T = "state");

public record TurnEvent(int Id, int N, double X, double Y, double D, double Time, int Dir, double V, string T = "turn");

public record BrakeEvent(int Id, bool On, double Time, string T = "brake");

public record DieEvent(int Id, double X, double Y, double Time, int Killer, string T = "die");

/// <summary>Every cycle's state at a moment: id, x, y, dir, v, a, lastTs, rubber, brakeRes, braking, dist, turns, frozen.</summary>
public record SyncEvent(double Time, double[][] C, string T = "sync");

public record SettingsEvent(object Settings, string T = "settings");

public record ServerList(RoomInfo[] Servers, int Online);
