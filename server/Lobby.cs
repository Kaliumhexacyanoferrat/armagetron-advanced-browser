// Armagetron Advanced, browser port. Copyright (C) 2026 Andreas Nägeli.
// Based on Armagetron Advanced, Copyright (C) Manuel Moos and the Armagetron Advanced team.
// GNU GPL version 2 or later, see COPYING.txt. Source: https://github.com/Kaliumhexacyanoferrat/armagetron-advanced-browser

// Every server (room) that players created, and the one loop that runs them.
// A room lives as long as people use it: when the last human leaves it stays
// open for a while, so its owner can come back, and then it goes away.

public sealed class Lobby
{
    public const string Version = "1";

    public const int MaxRooms = 24;

    public const int MaxClients = 300;

    /// <summary>Simulation steps per second, the same on the server and in the browser.</summary>
    public const int Rate = 60;

    private static readonly TimeSpan EmptyRoomLifetime = TimeSpan.FromMinutes(15);

    /// <summary>A server nobody ever joined (its maker closed the tab) goes sooner.</summary>
    private static readonly TimeSpan UnusedRoomLifetime = TimeSpan.FromMinutes(1);

    private readonly object _lock = new();

    private readonly Dictionary<string, Room> _rooms = [];

    private readonly DateTime _epoch = DateTime.UtcNow;

    private readonly Action<string> _log;

    public Lobby(Action<string> log)
    {
        _log = log;

        _ = Run();
    }

    /// <summary>Seconds since the lobby started; the clock every room and browser agree on.</summary>
    public double Now => (DateTime.UtcNow - _epoch).TotalSeconds;

    public void Log(string line) => _log(line);

    /// <summary>Called once a second from the loop (the hub drops silent connections).</summary>
    public Action EverySecond { get; set; }

    public RoomInfo[] List()
    {
        lock (_lock)
        {
            return [.. _rooms.Values.Where(r => !r.Hidden).Select(r => r.Info).Where(i => i != null)
                                     .OrderByDescending(i => i.Humans).ThenBy(i => i.Name)];
        }
    }

    public Room Find(string id)
    {
        lock (_lock)
        {
            return id != null && _rooms.TryGetValue(id, out var room) ? room : null;
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
                client.Send(new RoomList(List()));
                break;

            case "create":
                Create(client, message);
                break;

            case "join":
                var room = Find(message.Str("room"));

                if (room == null)
                {
                    client.Send(new Refused("That server does not exist any more."));
                    break;
                }

                // already there (or on the way): a second click changes nothing
                if (client.Room == room) break;

                Leave(client);

                client.Room = room;
                room.Post(client, "join", message);
                break;

            case "leave":
                Leave(client);
                client.Send(new RoomList(List()));
                break;
        }
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

            // a browser (or an address) may own a few servers, not an unlimited number of them
            if (_rooms.Values.Count(r => (client.Cid != "" && r.OwnerCid == client.Cid) || r.OwnerAddress == client.Address) >= 3)
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
        }

        _log($"server '{settings.Name}' ({room.Id}) created by {client.Name}");

        client.Send(new Created(room.Id, room.AdminToken));
    }

    public void Remove(Room room)
    {
        lock (_lock)
        {
            _rooms.Remove(room.Id);
        }

        room.Closed = true;
    }

    private async Task Run()
    {
        var step = 1.0 / Rate;

        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(step / 2));

        var simulated = Now;
        var second = Now;

        while (await timer.WaitForNextTickAsync())
        {
            // nothing may end this loop: every server runs on it
            try
            {
                Tick(ref simulated, step);

                if (Now - second >= 1)
                {
                    second = Now;
                    EverySecond?.Invoke();
                }
            }
            catch (Exception e)
            {
                _log($"lobby loop failed: {e}");
            }
        }
    }

    private void Tick(ref double simulated, double step)
    {
        var now = Now;

        // falling far behind (a paused machine): skip ahead instead of racing to catch up
        if (now - simulated > 0.5)
        {
            simulated = now - step;
        }

        Room[] rooms;

        lock (_lock)
        {
            rooms = [.. _rooms.Values];
        }

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
            if (room.Closed) continue;

            var empty = room.EmptySince is { } since ? DateTime.UtcNow - since : TimeSpan.Zero;

            if (room.EmptySince != null && (empty > EmptyRoomLifetime || (!room.EverJoined && empty > UnusedRoomLifetime)))
            {
                _log($"server '{room.Settings.Name}' ({room.Id}) closed after being empty");
                Remove(room);
            }
        }
    }
}
