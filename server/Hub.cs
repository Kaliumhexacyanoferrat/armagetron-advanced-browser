// The websocket handler behind "play". One instance serves every socket. It
// knows who is connected and hands each message to the lobby (list, create,
// join) or to the room the client is in. Rooms process what they are handed
// on their own loop, so nothing here touches game state directly.

public sealed class Hub(Lobby lobby) : IReactiveHandler
{
    private readonly ConcurrentDictionary<IReactiveConnection, Client> _clients = new();

    public int Online => _clients.Count;

    public ValueTask OnConnected(IReactiveConnection connection)
    {
        var client = new Client(connection);

        _clients[connection] = client;

        if (_clients.Count > Lobby.MaxClients)
        {
            client.Close("The server is full right now. Please try again later.");
            return ValueTask.CompletedTask;
        }

        client.Send(new Welcome(Lobby.Version, lobby.Now));

        return ValueTask.CompletedTask;
    }

    public ValueTask OnMessage(IReactiveConnection connection, IWebsocketFrame frame)
    {
        if (!_clients.TryGetValue(connection, out var client))
        {
            return ValueTask.CompletedTask;
        }

        client.LastSeen = DateTime.UtcNow;

        JsonElement message;

        try
        {
            var data = frame.Data;

            if (data.Length > 4096)
            {
                return ValueTask.CompletedTask;
            }

            using var doc = JsonDocument.Parse(data);

            message = doc.RootElement.Clone();
        }
        catch (Exception)
        {
            return ValueTask.CompletedTask;
        }

        if (message.ValueKind != JsonValueKind.Object)
        {
            return ValueTask.CompletedTask;
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
            case "leave":
                lobby.Handle(client, type, message);
                break;

            default:
                client.Room?.Post(client, type, message);
                break;
        }

        return ValueTask.CompletedTask;
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

    public async ValueTask OnClose(IReactiveConnection connection, IWebsocketFrame frame)
    {
        if (_clients.TryRemove(connection, out var client))
        {
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
