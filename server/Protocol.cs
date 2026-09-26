// Armagetron Advanced, browser port. Copyright (C) 2026 Andreas Nägeli.
// Based on Armagetron Advanced, Copyright (C) Manuel Moos and the Armagetron Advanced team.
// GNU GPL version 2 or later, see COPYING.txt. Source: https://github.com/Kaliumhexacyanoferrat/armagetron-advanced-browser

// Messages the server sends. Most are JSON with a "t" for their type; the
// frequent ones of the game itself (sync, turn, die, brake) are small binary
// frames, written by Wire below and read by web/js/net.js.
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

/// <summary>The first servers of the sorted list, and how many there are in all.</summary>
public record RoomList(RoomInfo[] Rooms, int Total, string T = "rooms");

public record RoomInfo(string Id, string Name, string Owner, int Humans, int Bots, int Max, bool Locked, int Round, string Mode, int Spectators);

public record Chat(int From, string Name, string Text, string Kind, string T = "chat");

/// <summary>A line in the console, possibly with 0xRRGGBB colour codes.</summary>
public record Message(string Text, string T = "msg");

/// <summary>A big message in the middle of the screen.</summary>
public record Center(string Text, double Duration, string T = "center");

public record PlayerInfo(int Id, string Name, int R, int G, int B, int Score, bool Alive, int Ping, bool Bot, bool Admin, bool Spectator, int Kills, bool Chatting);

public record Players(PlayerInfo[] List, string T = "players");

/// <summary>What changed since the last list: [id, score, kills, alive (0/1), chatting (0/1)] each.</summary>
public record PlayerChanges(int[][] C, string T = "pc");

public record Kicked(string Reason, string T = "kicked");

public record BanInfo(int Index, string Name, double Minutes);

public record BanList(BanInfo[] Bans, string T = "bans");

// the game itself

public record CycleInfo(int Id, string Name, int R, int G, int B, bool Alive, double DeathTime,
                        double X, double Y, int Dir, double V, double A, double LastTs, double Rubber, double RubberEff, double BrakeRes, bool Braking,
                        double Dist, int Turns, double LastTurnTime, double Time, double[][] Points, double[][] Holes);

/// <summary>Everything about the current round, for a browser that joins or starts one.</summary>
public record Snapshot(int Round, string Phase, double Start, double Now, object Sim, double Size, CycleInfo[] Cycles, string T = "state");

public record SettingsEvent(object Settings, string T = "settings");

public record ServerList(RoomInfo[] Servers, int Total, int Online);

public record PhaseEvent(string Phase, double Next, string T = "phase");

/// <summary>
/// The binary frames, little endian, their first byte the type. A turn is
/// about 40 bytes instead of 140 as JSON, a cycle in a sync 41 instead of 80.
///
///   1 sync   f64 time, u8 count, count x cycle:
///            u16 id, u8 dir | braking &lt;&lt; 2 | frozen &lt;&lt; 3, u16 turns,
///            f32 x, y, v, a, lastTs, rubber, brakeRes, f64 dist
///   2 turn   u16 id, u16 n, u8 dir, f64 x, y, d, time, f32 v
///   3 die    u16 id, f64 x, y, time, i16 killer
///   4 brake  u16 id, u8 on, f64 time
/// </summary>
public static class Wire
{
    private const int CycleBytes = 41;

    public static byte[] Sync(double time, List<Cycle> cycles)
    {
        var count = 0;

        foreach (var c in cycles)
        {
            if (c.Alive) count++;
        }

        if (count == 0) return null;

        count = Math.Min(count, 255);

        var b = new byte[10 + count * CycleBytes];
        var w = new Writer(b);

        w.U8(1);
        w.F64(time);
        w.U8(count);

        var written = 0;

        foreach (var c in cycles)
        {
            if (!c.Alive) continue;

            if (written++ == count) break;

            w.U16(c.Id);
            w.U8(c.Dir | (c.Braking ? 4 : 0) | (c.Frozen ? 8 : 0));
            w.U16(c.Turns);
            w.F32(c.X);
            w.F32(c.Y);
            w.F32(c.V);
            w.F32(c.A);
            w.F32(c.LastTs);
            w.F32(c.Rubber);
            w.F32(c.BrakeRes);
            w.F64(c.Dist);
        }

        return b;
    }

    public static byte[] Turn(int id, int n, double x, double y, double d, double time, int dir, double v)
    {
        var b = new byte[42];
        var w = new Writer(b);

        w.U8(2);
        w.U16(id);
        w.U16(n);
        w.U8(dir);
        w.F64(x);
        w.F64(y);
        w.F64(d);
        w.F64(time);
        w.F32(v);

        return b;
    }

    public static byte[] Die(int id, double x, double y, double time, int killer)
    {
        var b = new byte[29];
        var w = new Writer(b);

        w.U8(3);
        w.U16(id);
        w.F64(x);
        w.F64(y);
        w.F64(time);
        w.I16(killer);

        return b;
    }

    public static byte[] Brake(int id, bool on, double time)
    {
        var b = new byte[12];
        var w = new Writer(b);

        w.U8(4);
        w.U16(id);
        w.U8(on ? 1 : 0);
        w.F64(time);

        return b;
    }

    private ref struct Writer(byte[] buffer)
    {
        private readonly Span<byte> _b = buffer;

        private int _at;

        public void U8(int v) => _b[_at++] = (byte)v;

        public void U16(int v)
        {
            System.Buffers.Binary.BinaryPrimitives.WriteUInt16LittleEndian(_b[_at..], (ushort)v);
            _at += 2;
        }

        public void I16(int v)
        {
            System.Buffers.Binary.BinaryPrimitives.WriteInt16LittleEndian(_b[_at..], (short)Math.Clamp(v, short.MinValue, short.MaxValue));
            _at += 2;
        }

        public void F32(double v)
        {
            System.Buffers.Binary.BinaryPrimitives.WriteSingleLittleEndian(_b[_at..], (float)v);
            _at += 4;
        }

        public void F64(double v)
        {
            System.Buffers.Binary.BinaryPrimitives.WriteDoubleLittleEndian(_b[_at..], v);
            _at += 8;
        }
    }
}
