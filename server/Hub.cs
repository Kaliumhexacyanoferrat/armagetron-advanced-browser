// Armagetron Advanced, browser port. Copyright (C) 2026 Andreas Nägeli.
// Based on Armagetron Advanced, Copyright (C) Manuel Moos and the Armagetron Advanced team.
// GNU GPL version 2 or later, see COPYING.txt. Source: https://github.com/Kaliumhexacyanoferrat/armagetron-advanced-browser

// The websocket handler behind "play". One instance serves every socket. It
// knows who is connected and hands each message to the lobby (list, create,
// join) or to the room the client is in. Rooms process what they are handed
// on their own loop, so nothing here touches game state directly.

public sealed class Hub(Lobby lobby) : IReactiveHandler
{
    private readonly ConcurrentDictionary<IReactiveConnection, Client> _clients = new();

    // connections per address, counted as they come and go (not by looking at all of them)
    private readonly ConcurrentDictionary<string, int> _perAddress = new();

    public int Online => _clients.Count;

    /// <summary>Connections from one address at most (a household or an office shares one).</summary>
    private const int MaxPerAddress = 16;

    public ValueTask OnConnected(IReactiveConnection connection)
    {
        try
        {
            var client = new Client(connection);

            _clients[connection] = client;

            var fromHere = _perAddress.AddOrUpdate(client.Address, 1, (_, n) => n + 1);

            if (_clients.Count > Lobby.MaxClients)
            {
                client.Close("The server is full right now. Please try again later.");
                return ValueTask.CompletedTask;
            }

            if (fromHere > MaxPerAddress)
            {
                client.Close("Too many connections from your address.");
                return ValueTask.CompletedTask;
            }

            client.Send(new Welcome(Lobby.Version, lobby.Now));
        }
        catch (Exception e)
        {
            lobby.Log($"connect failed: {e.Message}");
        }

        return ValueTask.CompletedTask;
    }

    public ValueTask OnMessage(IReactiveConnection connection, IWebsocketFrame frame)
    {
        // nothing a browser sends may break the connection's handler: a
        // handler that throws is never closed (OnClose does not run)
        try
        {
            Handle(connection, frame);
        }
        catch (Exception e)
        {
            lobby.Log($"message failed: {e.Message}");
        }

        return ValueTask.CompletedTask;
    }

    private void Handle(IReactiveConnection connection, IWebsocketFrame frame)
    {
        if (!_clients.TryGetValue(connection, out var client) || client.Closed)
        {
            return;
        }

        client.LastSeen = DateTime.UtcNow;

        if (!client.Allow(lobby.Now))
        {
            return;
        }

        JsonElement message;

        try
        {
            var data = frame.Data;

            if (data.Length > 4096)
            {
                return;
            }

            using var doc = JsonDocument.Parse(data);

            message = doc.RootElement.Clone();
        }
        catch (Exception)
        {
            return;
        }

        if (message.ValueKind != JsonValueKind.Object)
        {
            return;
        }

        var type = message.Str("t");

        switch (type)
        {
            case "ping":
                // answered straight away, not on the room loop, so the round trip is honest
                client.Send(new Pong(message.Num("c"), lobby.Now));
                client.Rtt = Math.Clamp(message.Num("l", client.Rtt), 0, 2);
                break;

            case "hello":
            case "list":
            case "create":
            case "join":
            case "quick":
            case "leave":
                lobby.Handle(client, type, message);
                break;

            case null:
                break;

            default:
                client.Room?.Post(client, type, message);
                break;
        }
    }

    /// <summary>
    /// Drops connections that went quiet: a browser pings every second, so
    /// one silent for half a minute is gone without having said so.
    /// </summary>
    public void Sweep()
    {
        var now = DateTime.UtcNow;

        foreach (var (connection, client) in _clients)
        {
            var silent = now - client.LastSeen;

            if (silent > TimeSpan.FromSeconds(30) && !client.Closed)
            {
                client.Room?.Post(client, "gone", default);
                client.Close();
            }
            else if (silent > TimeSpan.FromSeconds(90))
            {
                // not even the close went through: the connection is dead
                if (_clients.TryRemove(connection, out _)) Forget(client);
            }
        }
    }

    // pongs go through the client's queue too: one writer per socket
    public ValueTask OnPing(IReactiveConnection connection, IWebsocketFrame frame)
    {
        if (_clients.TryGetValue(connection, out var client))
        {
            client.Pong(frame.Data);
        }

        return ValueTask.CompletedTask;
    }

    private void Forget(Client client)
    {
        if (_perAddress.AddOrUpdate(client.Address, 0, (_, n) => n - 1) <= 0)
        {
            _perAddress.TryRemove(new KeyValuePair<string, int>(client.Address, 0));
        }
    }

    public async ValueTask OnClose(IReactiveConnection connection, IWebsocketFrame frame)
    {
        if (_clients.TryRemove(connection, out var client))
        {
            Forget(client);

            client.Room?.Post(client, "gone", default);

            // the socket is only answered once nothing else writes to it
            await client.ShutdownAsync();
        }
        else
        {
            try
            {
                await connection.CloseAsync();
            }
            catch (Exception)
            {
                // gone already
            }
        }
    }

    public ValueTask<bool> OnError(IReactiveConnection connection, FrameError error) => ValueTask.FromResult(true);
}
