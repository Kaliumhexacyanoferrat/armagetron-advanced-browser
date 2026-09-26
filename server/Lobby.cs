// Armagetron Advanced, browser port. Copyright (C) 2026 Andreas Nägeli.
// Based on Armagetron Advanced, Copyright (C) Manuel Moos and the Armagetron Advanced team.
// GNU GPL version 2 or later, see COPYING.txt. Source: https://github.com/Kaliumhexacyanoferrat/armagetron-advanced-browser

// Every server (room) that players created, and the loops that run them.
// A room lives as long as people use it: when the last human leaves it stays
// open for a while, so its owner can come back, and then it goes away.
//
// The rooms are spread over a few loops that tick independently, each room
// always on the same one: rooms share nothing, so a busy machine uses all its
// cores. A loop measures how busy it is; when all of them are nearly full, no
// new servers are opened, so the running ones keep their pace.

public sealed class Lobby
{
    public const string Version = "1";

    public const int MaxRooms = 2000;

    public const int MaxClients = 12000;

    /// <summary>Simulation steps per second, the same on the server and in the browser.</summary>
    public const int Rate = 60;

    /// <summary>
    /// How many loops run the rooms. Lambdas may not ask for the number of
    /// cores; on a machine of your own, make this about that number.
    /// </summary>
    private const int Loops = 4;

    /// <summary>A loop busier than this (a fraction of its time) takes no new rooms.</summary>
    private const double FullLoad = 0.75;

    /// <summary>The front page lists this many servers, the most interesting first.</summary>
    private const int Listed = 60;

    private static readonly TimeSpan EmptyRoomLifetime = TimeSpan.FromMinutes(15);

    /// <summary>A server nobody ever joined (its maker closed the tab) goes sooner.</summary>
    private static readonly TimeSpan UnusedRoomLifetime = TimeSpan.FromMinutes(1);

    private readonly object _lock = new();

    private readonly Dictionary<string, Room> _rooms = [];

    private readonly Loop[] _loops;

    private readonly DateTime _epoch = DateTime.UtcNow;

    private readonly Action<string> _log;

    // the list of servers, sorted and encoded at most once a second for everybody who asks
    private RoomInfo[] _sorted = [];

    private byte[] _listFrame;

    private double _listAt = double.NegativeInfinity;

    public Lobby(Action<string> log)
    {
        _log = log;

        _loops = new Loop[Loops];

        for (var i = 0; i < Loops; i++)
        {
            _loops[i] = new Loop();
            _ = Run(_loops[i], housekeeping: i == 0);
        }
    }

    private sealed class Loop
    {
        /// <summary>Its rooms; replaced (never changed) when one comes or goes.</summary>
        public volatile Room[] Rooms = [];

        /// <summary>The fraction of the last second spent ticking.</summary>
        public volatile float Load;
    }

    /// <summary>Seconds since the lobby started; the clock every room and browser agree on.</summary>
    public double Now => (DateTime.UtcNow - _epoch).TotalSeconds;

    public void Log(string line) => _log(line);

    /// <summary>Called once a second from a loop (the hub drops silent connections).</summary>
    public Action EverySecond { get; set; }

    /// <summary>The servers for the front page, the most interesting first.</summary>
    public RoomInfo[] Top
    {
        get
        {
            var all = Sorted();
            return all.Length <= Listed ? all : all[..Listed];
        }
    }

    public int Count => Sorted().Length;

    public Room Find(string id)
    {
        lock (_lock)
        {
            return id != null && _rooms.TryGetValue(id, out var room) ? room : null;
        }
    }

    /// <summary>
    /// The order of the front page: servers where people play and a place is
    /// free, then full ones, then empty ones; the more players the higher.
    /// </summary>
    private static int Group(RoomInfo i) => i.Humans == 0 ? 2 : i.Humans >= i.Max ? 1 : 0;

    private RoomInfo[] Sorted()
    {
        lock (_lock)
        {
            if (Now - _listAt < 1) return _sorted;

            var list = new List<RoomInfo>(_rooms.Count);

            foreach (var room in _rooms.Values)
            {
                if (!room.Closed && !room.Hidden && room.Info is { } info) list.Add(info);
            }

            list.Sort((a, b) =>
            {
                var g = Group(a).CompareTo(Group(b));
                if (g != 0) return g;

                var h = b.Humans.CompareTo(a.Humans);
                return h != 0 ? h : string.CompareOrdinal(a.Name, b.Name);
            });

            _sorted = [.. list];
            _listFrame = Json.Encode(new RoomList(_sorted.Length <= Listed ? _sorted : _sorted[..Listed], _sorted.Length));
            _listAt = Now;

            return _sorted;
        }
    }

    private byte[] ListFrame()
    {
        Sorted();

        lock (_lock)
        {
            return _listFrame;
        }
    }

    public void Handle(Client client, string type, JsonElement message)
    {
        switch (type)
        {
            case "hello":
                client.Name = Names.Clean(message.Str("name"), "Player " + client.Id);
                client.Cid = Names.Token(message.Str("cid"));

                var (r, g, b) = Names.Color(message.Int("r", 15), message.Int("g", 15), message.Int("b", 4));
                client.R = r;
                client.G = g;
                client.B = b;

                client.Room?.Post(client, "profile", default);
                break;

            case "list":
                client.Send(ListFrame());
                break;

            case "create":
                Create(client, message);
                break;

            case "join":
                Join(client, Find(message.Str("room")), message);
                break;

            case "quick":
                // where people play and a place is free; if there is no such server, a new one
                var pick = Sorted().FirstOrDefault(i => i.Humans > 0 && i.Humans < i.Max && !i.Locked && i.Id != client.Room?.Id);

                if (pick != null && Find(pick.Id) is { } room)
                {
                    Join(client, room, message);
                }
                else
                {
                    Create(client, message);
                }
                break;

            case "leave":
                Leave(client);
                client.Send(ListFrame());
                break;
        }
    }

    private static void Join(Client client, Room room, JsonElement message)
    {
        if (room == null)
        {
            client.Send(new Refused("That server does not exist any more."));
            return;
        }

        // already there (or on the way): a second click changes nothing
        if (client.Room == room) return;

        Leave(client);

        client.Room = room;
        room.Post(client, "join", message);
    }

    private static void Leave(Client client)
    {
        var current = client.Room;

        if (current != null)
        {
            client.Room = null;
            current.Post(client, "gone", default);
        }
    }

    private void Create(Client client, JsonElement message)
    {
        var settings = RoomSettings.From(message.TryGetProperty("settings", out var s) ? s : message, null);

        Room room;

        lock (_lock)
        {
            if (_rooms.Count >= MaxRooms)
            {
                client.Send(new Refused($"There are already {MaxRooms} servers running. Join one of them, or try again in a while."));
                return;
            }

            // the least busy loop takes it, unless all of them are nearly full
            var loop = _loops[0];

            foreach (var l in _loops)
            {
                if (l.Load < loop.Load || (l.Load == loop.Load && l.Rooms.Length < loop.Rooms.Length)) loop = l;
            }

            if (loop.Load > FullLoad)
            {
                client.Send(new Refused("The machine is busy with the servers running now. Join one of them, or try again in a while."));
                return;
            }

            // a browser (or an address) may own a few servers, not an unlimited number of them
            var owned = 0;

            foreach (var r in _rooms.Values)
            {
                if ((client.Cid != "" && r.OwnerCid == client.Cid) || r.OwnerAddress == client.Address) owned++;
            }

            if (owned >= 3)
            {
                client.Send(new Refused("You already run three servers. Close one before you create another."));
                return;
            }

            string id;

            do
            {
                id = Names.RoomId();
            }
            while (_rooms.ContainsKey(id));

            room = new Room(this, id, settings, client.Cid, client.Name, _log) { OwnerAddress = client.Address };

            _rooms[id] = room;
            loop.Rooms = [.. loop.Rooms, room];

            // the new server shows at once
            _listAt = double.NegativeInfinity;
        }

        _log($"server '{settings.Name}' ({room.Id}) created by {client.Name}");

        client.Send(new Created(room.Id, room.AdminToken));
    }

    public void Remove(Room room)
    {
        lock (_lock)
        {
            _rooms.Remove(room.Id);

            foreach (var loop in _loops)
            {
                if (Array.IndexOf(loop.Rooms, room) >= 0) loop.Rooms = [.. loop.Rooms.Where(r => r != room)];
            }

            _listAt = double.NegativeInfinity;
        }

        room.Closed = true;
    }

    private async Task Run(Loop loop, bool housekeeping)
    {
        var step = 1.0 / Rate;

        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(step / 2));

        var simulated = Now;
        var second = Now;
        var busy = 0.0;

        while (await timer.WaitForNextTickAsync())
        {
            // nothing may end this loop: its servers run on it
            try
            {
                var start = Now;

                Tick(loop, ref simulated, step);

                busy += Now - start;

                if (start - second >= 1)
                {
                    loop.Load = (float)(busy / (start - second));
                    busy = 0;
                    second = start;

                    if (housekeeping) EverySecond?.Invoke();
                }
            }
            catch (Exception e)
            {
                _log($"lobby loop failed: {e}");
            }
        }
    }

    private void Tick(Loop loop, ref double simulated, double step)
    {
        var now = Now;

        // falling far behind (a paused machine): skip ahead instead of racing to catch up
        if (now - simulated > 0.5)
        {
            simulated = now - step;
        }

        var rooms = loop.Rooms;

        while (simulated + step <= now)
        {
            simulated += step;

            foreach (var room in rooms)
            {
                if (room.Closed) continue;

                try
                {
                    room.Tick(simulated);
                    room.Failures = 0;
                }
                catch (Exception e)
                {
                    // once in the log is enough; a server that keeps failing is closed
                    if (room.Failures++ == 0) _log($"room {room.Id} failed: {e}");

                    if (room.Failures > 120)
                    {
                        _log($"server '{room.Settings.Name}' ({room.Id}) closed after failing");
                        room.Shutdown("This server broke down, sorry. Please join another one.");
                        Remove(room);
                    }
                }
            }
        }

        foreach (var room in rooms)
        {
            if (room.Closed || room.EmptySince is not { } since) continue;

            var empty = DateTime.UtcNow - since;

            if (empty > EmptyRoomLifetime || (!room.EverJoined && empty > UnusedRoomLifetime))
            {
                _log($"server '{room.Settings.Name}' ({room.Id}) closed after being empty");
                Remove(room);
            }
        }
    }
}
