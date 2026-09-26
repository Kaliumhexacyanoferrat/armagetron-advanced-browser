// Armagetron Advanced, browser port. Copyright (C) 2026 Andreas Nägeli.
// Based on Armagetron Advanced, Copyright (C) Manuel Moos and the Armagetron Advanced team.
// GNU GPL version 2 or later, see COPYING.txt. Source: https://github.com/Kaliumhexacyanoferrat/armagetron-advanced-browser

// One game server that a player created. Everything that happens in it runs
// on the lobby's loop, one tick at a time: messages from browsers are queued
// by the hub (Post) and handled at the start of the next tick, so the game
// state never needs a lock.
//
//   Room.cs      who is in the room, joining and leaving, sending
//   Game.cs      rounds, the simulation, lag compensation, scores
//   Chat.cs      chat, chat commands, spam protection, administration
//   Bot.cs       the AI players

public sealed class RoomSettings
{
    public string Name = "Unnamed Server";

    public string Password = "";

    public int MaxPlayers = 8, MinPlayers = 4, AiIq = 50;

    public int SizeFactor = -3, SpeedFactor = 0;

    public int ScoreLimit = 100, RoundLimit = 10;

    // CYCLE_RUBBER: the original's default is 1, but most servers played with more
    public double Rubber = 5, WallsLength = -1, WallsStayUp = 8;

    public static RoomSettings From(JsonElement e, RoomSettings previous)
    {
        var p = previous ?? new RoomSettings();

        if (e.ValueKind != JsonValueKind.Object) return p.Copy();

        return new RoomSettings
        {
            Name = Names.Clean(e.Str("name"), p.Name, 30),
            Password = e.TryGetProperty("password", out var pw) && pw.ValueKind == JsonValueKind.String ? Names.Clean(pw.GetString(), "", 30) : p.Password,
            MaxPlayers = Math.Clamp(e.Int("maxPlayers", p.MaxPlayers), 1, 16),
            MinPlayers = Math.Clamp(e.Int("minPlayers", p.MinPlayers), 0, 12),
            AiIq = Math.Clamp(e.Int("aiIq", p.AiIq), 0, 100),
            SizeFactor = Math.Clamp(e.Int("sizeFactor", p.SizeFactor), -6, 2),
            SpeedFactor = Math.Clamp(e.Int("speedFactor", p.SpeedFactor), -4, 4),
            ScoreLimit = Math.Clamp(e.Int("scoreLimit", p.ScoreLimit), 10, 10000),
            RoundLimit = Math.Clamp(e.Int("roundLimit", p.RoundLimit), 1, 1000),
            Rubber = Math.Clamp(e.Num("rubber", p.Rubber), 0.5, 50),
            WallsLength = e.Num("wallsLength", p.WallsLength) is var wl && wl > 0 ? Math.Clamp(wl, 20, 5000) : -1,
            WallsStayUp = Math.Clamp(e.Num("wallsStayUp", p.WallsStayUp), -1, 60)
        };
    }

    public RoomSettings Copy() => (RoomSettings)MemberwiseClone();

    /// <summary>The rules for a round: the original's SPEED_FACTOR scales speed, acceleration, brake and turn delay.</summary>
    public SimSettings Sim()
    {
        var m = Math.Pow(2, SpeedFactor / 2.0);

        var s = new SimSettings
        {
            Rubber = Rubber,
            WallsLength = WallsLength,
            WallsStayUp = WallsStayUp,
            SizeFactor = SizeFactor
        };

        s.Speed *= m;
        s.StartSpeed *= m;
        s.Accel *= m;
        s.Brake *= m;
        s.Delay /= m;

        return s;
    }

    public object ToWire(bool withPassword) => new Dictionary<string, object>
    {
        ["name"] = Name, ["password"] = withPassword ? Password : (Password != "" ? "***" : ""),
        ["maxPlayers"] = MaxPlayers, ["minPlayers"] = MinPlayers, ["aiIq"] = AiIq,
        ["sizeFactor"] = SizeFactor, ["speedFactor"] = SpeedFactor,
        ["scoreLimit"] = ScoreLimit, ["roundLimit"] = RoundLimit,
        ["rubber"] = Rubber, ["wallsLength"] = WallsLength, ["wallsStayUp"] = WallsStayUp
    };
}

public sealed class Player
{
    public int Id;

    public Client Client;

    public Bot Bot;

    public string Name;

    public int R, G, B;

    public int Score, Kills;

    public bool Admin, Spectator, WantsSpectator, Chatting;

    /// <summary>The cycle of this round, if the player takes part in it.</summary>
    public Cycle Cycle;

    public bool IsBot => Bot != null;

    public double Rtt => Client?.Rtt ?? 0;

    // lag compensation: the cycle's state after each tick, turns that arrived
    // before the server got to where they were made, and a death waiting for
    // a late turn that might still have avoided it
    public readonly List<CycleState> History = [];

    public readonly List<TurnCommand> Pending = [];

    public Doom Doom;

    public int LastTurnN;

    public double LastRename = -100;

    // spam protection (nSpamProtection)
    public double SpamLevel, SpamTime;

    public string LastChat = "";

    public double LastChatTime = -100;

    public int SpamWarnings;

    public string Colored => $"0x{Hex(R)}{Hex(G)}{Hex(B)}{Name}0xRESETT";

    private static string Hex(int c) => ((int)Math.Round(c / 15.0 * 255)).ToString("x2");
}

public sealed record TurnCommand(int D, int N, double Dist, double Received);

public sealed record Doom(double Time, int Owner, double Until);

public sealed record Ban(string Name, string Cid, string Address, double Until);

public sealed partial class Room
{
    private readonly Lobby _lobby;

    private readonly Action<string> _log;

    private readonly ConcurrentQueue<(Client Client, string Type, JsonElement Message)> _inbox = new();

    private readonly List<Player> _players = [];

    private readonly List<Ban> _bans = [];

    private readonly Dictionary<string, double> _kicked = [];

    private readonly LinkedList<string> _recent = new();

    private int _nextPlayerId = 1;

    private double _now;

    private double _lastInfo = -10, _lastPlayers = -10;

    private bool _playersChanged = true;

    public Room(Lobby lobby, string id, RoomSettings settings, string ownerCid, string ownerName, Action<string> log)
    {
        _lobby = lobby;
        _log = log;

        Id = id;
        Settings = settings;
        OwnerCid = ownerCid;
        OwnerName = ownerName;
        AdminToken = Names.Secret();

        _now = lobby.Now;

        EmptySince = DateTime.UtcNow;

        UpdateInfo();
    }

    public string Id { get; }

    public RoomSettings Settings { get; private set; }

    public string OwnerCid { get; }

    public string OwnerName { get; }

    public string OwnerAddress { get; init; } = "";

    /// <summary>Taken off the lobby: nobody gets in any more.</summary>
    public volatile bool Closed;

    /// <summary>Whether anybody ever joined (a server nobody uses goes away sooner).</summary>
    public bool EverJoined { get; private set; }

    /// <summary>Ticks in a row that failed, counted by the lobby.</summary>
    public int Failures;

    public string AdminToken { get; }

    public volatile RoomInfo Info;

    public bool Hidden => false;

    /// <summary>When the last human left; the lobby closes rooms that stay empty.</summary>
    public DateTime? EmptySince { get; private set; }

    public void Post(Client client, string type, JsonElement message)
    {
        if (Closed)
        {
            // the lobby just closed this server
            if (type == "join")
            {
                ClearRoom(client);
                client.Send(new Refused("That server does not exist any more."));
            }

            return;
        }

        _inbox.Enqueue((client, type, message));
    }

    /// <summary>The client leaves this room, unless it already went on to another one.</summary>
    private void ClearRoom(Client client) => client.LeaveRoom(this);

    /// <summary>The lobby closes this server: everybody back to the list.</summary>
    public void Shutdown(string reason)
    {
        foreach (var p in _players)
        {
            if (p.Client == null) continue;

            ClearRoom(p.Client);
            p.Client.Send(new Kicked(reason));
        }
    }

    private IEnumerable<Player> Humans => _players.Where(p => !p.IsBot);

    private Player Find(Client client) => _players.FirstOrDefault(p => p.Client == client);

    public void Tick(double now)
    {
        _now = now;

        while (_inbox.TryDequeue(out var item))
        {
            try
            {
                Handle(item.Client, item.Type, item.Message);
            }
            catch (Exception e)
            {
                _log($"room {Id}: {item.Type} failed: {e.Message}");
            }
        }

        if (!Humans.Any())
        {
            // nobody to play for: the room sleeps
            if (_phase != Phase.Idle) Idle();
            return;
        }

        Game(now);

        if (_playersChanged && now - _lastPlayers > 0.25 || now - _lastPlayers > 2)
        {
            SendPlayers();
        }

        if (now - _lastInfo > 1)
        {
            UpdateInfo();
        }
    }

    private void Handle(Client client, string type, JsonElement message)
    {
        if (type == "join")
        {
            Join(client, message);
            return;
        }

        var player = Find(client);

        if (player == null) return;

        switch (type)
        {
            case "gone":
                Leave(player, null);
                break;

            case "profile":
                Profile(player);
                break;

            case "turn":
                OnTurn(player, message);
                break;

            case "brake":
                OnBrake(player, message.Bool("on"));
                break;

            case "chat":
                OnChat(player, message.Str("text"));
                break;

            case "typing":
                var typing = message.Bool("on");
                if (player.Chatting != typing)
                {
                    player.Chatting = typing;
                    _playersChanged = true;
                }
                break;

            case "spectate":
                ToggleSpectator(player, message.Bool("on"));
                break;

            case "admin":
                OnAdmin(player, message);
                break;
        }
    }

    // -----------------------------------------------------------------------
    // Joining and leaving

    private bool IsBanned(Client client, out Ban ban)
    {
        _bans.RemoveAll(b => b.Until < _now);

        ban = _bans.FirstOrDefault(b => (b.Cid != "" && b.Cid == client.Cid) || b.Address == client.Address);

        return ban != null;
    }

    private void Join(Client client, JsonElement message)
    {
        if (client.Closed || client.Room != this) return;

        if (Find(client) != null) return;

        var admin = Names.Same(message.Str("token"), AdminToken);

        if (!admin)
        {
            if (IsBanned(client, out var ban))
            {
                var minutes = double.IsPositiveInfinity(ban.Until) ? "" : $" for another {Math.Ceiling((ban.Until - _now) / 60)} minutes";
                Refuse(client, $"You are banned from this server{minutes}.", "banned");
                return;
            }

            foreach (var key in new[] { client.Cid, client.Address })
            {
                if (key != "" && _kicked.TryGetValue(key, out var until) && until > _now)
                {
                    Refuse(client, $"You were kicked from this server. You can come back in {Math.Ceiling(until - _now)} seconds.", "kicked");
                    return;
                }
            }

            // cleaned like the password was when it was set
            if (Settings.Password != "" && Names.Clean(message.Str("password"), "", 30) != Settings.Password)
            {
                Refuse(client, message.Str("password") == null ? "This server is protected by a password." : "That password is not right.", "password");
                return;
            }
        }

        if (_players.Count(p => !p.IsBot) >= 32)
        {
            Refuse(client, "This server is full.", "full");
            return;
        }

        var player = new Player
        {
            Id = _nextPlayerId++,
            Client = client,
            Name = UniqueName(client.Name, null),
            R = client.R,
            G = client.G,
            B = client.B,
            Admin = admin
        };

        var playing = Humans.Count(p => !p.WantsSpectator);

        if (playing >= Settings.MaxPlayers || message.Bool("spectate"))
        {
            player.WantsSpectator = true;
            player.Spectator = true;
        }

        _players.Add(player);
        _playersChanged = true;

        EmptySince = null;
        EverJoined = true;

        client.Send(new Joined(Id, player.Id, admin, admin ? AdminToken : null, Settings.ToWire(admin), OwnerName));

        foreach (var line in _recent)
        {
            client.Send(new Message(line));
        }

        client.Send(Snapshot());

        Broadcast(player.Spectator
            ? $"{player.Colored} 0x7fff7fentered as spectator."
            : $"{player.Colored} 0x7fff7fentered the game.");

        if (admin)
        {
            client.Send(new Message("0xffff7fYou are the administrator of this server. Open the menu (Esc) to change its settings; kick or ban players from the score table (Tab) or with /kick and /ban."));
        }
        else if (player.Spectator && playing >= Settings.MaxPlayers)
        {
            client.Send(new Message("0xff7f7fThe server is full, so you watch as a spectator for now. Press B to play once a place is free."));
        }

        _log($"{client.Name} joined '{Settings.Name}' ({Id})");

        SpawnLate(player);
    }

    private void Refuse(Client client, string reason, string code)
    {
        ClearRoom(client);

        client.Send(new Refused(reason, code));
    }

    private void Leave(Player player, string how)
    {
        if (!_players.Remove(player)) return;

        _playersChanged = true;

        if (player.Cycle is { Alive: true } c)
        {
            // the cycle goes with its player, without scores changing hands
            Finalize(player, c.Frozen && player.Doom != null ? player.Doom.Time : _now, -1, silent: true);
        }

        if (player.Client != null)
        {
            ClearRoom(player.Client);
        }

        Broadcast(how ?? (player.Spectator
            ? $"0xff7f7fSpectator {player.Colored} 0xff7f7fleft."
            : $"{player.Colored} 0xff7f7fleft the game."));

        if (!Humans.Any())
        {
            EmptySince = DateTime.UtcNow;
        }

        UpdateInfo();
    }

    private void Profile(Player player)
    {
        var client = player.Client;

        var name = UniqueName(client.Name, player);

        if (name != player.Name)
        {
            var old = player.Colored;
            player.Name = name;

            // one announcement for a burst of renames, not one per letter
            if (_now - player.LastRename > 3) Broadcast($"{old} renamed to {player.Colored}.");

            player.LastRename = _now;
        }

        // a new colour shows from the next round on, the cycle keeps its own
        player.R = client.R;
        player.G = client.G;
        player.B = client.B;

        _playersChanged = true;
    }

    /// <summary>ALLOW_IMPOSTERS 0: a name somebody else has gets a number.</summary>
    private string UniqueName(string wanted, Player self)
    {
        bool Taken(string n) => _players.Any(p => p != self && string.Equals(Names.Visible(p.Name), Names.Visible(n), StringComparison.OrdinalIgnoreCase));

        if (!Taken(wanted)) return wanted;

        var stem = wanted.Length > 13 ? wanted[..13] : wanted;

        for (var i = 2; ; i++)
        {
            var candidate = stem + i;

            if (!Taken(candidate)) return candidate;
        }
    }

    // -----------------------------------------------------------------------
    // Sending

    private void Send(object message)
    {
        var frame = Json.Encode(message);

        foreach (var p in _players)
        {
            p.Client?.Send(frame);
        }
    }

    private void SendAll(byte[] binary)
    {
        foreach (var p in _players)
        {
            p.Client?.Send(binary, FrameType.Binary);
        }
    }

    /// <summary>A console line for everybody, remembered for those who join later.</summary>
    private void Broadcast(string text)
    {
        _recent.AddLast(text);

        while (_recent.Count > 12) _recent.RemoveFirst();

        Send(new Message(text));
    }

    private void Center(string text, double duration = 5) => Send(new Center(text, duration));

    private void SendPlayers()
    {
        _lastPlayers = _now;
        _playersChanged = false;

        var list = _players
            .OrderByDescending(p => p.Score)
            .ThenBy(p => p.Spectator)
            .Select(p => new PlayerInfo(p.Id, p.Name, p.R, p.G, p.B, p.Score,
                                        p.Cycle is { Alive: true }, (int)Math.Round(p.Rtt * 1000), p.IsBot, p.Admin, p.Spectator, p.Kills, p.Chatting))
            .ToArray();

        Send(new Players(list));
    }

    private void UpdateInfo()
    {
        _lastInfo = _now;

        Info = new RoomInfo(Id, Settings.Name, OwnerName,
                            Humans.Count(p => !p.Spectator), _players.Count(p => p.IsBot), Settings.MaxPlayers,
                            Settings.Password != "", _round, "Free for all", Humans.Count(p => p.Spectator));
    }
}
