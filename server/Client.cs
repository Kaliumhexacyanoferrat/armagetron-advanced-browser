// One browser connected over the websocket. Everything the server sends goes
// through Send, which queues the frame: a single pump per client writes the
// queue to the socket, so there is never more than one write at a time and a
// slow browser only ever slows down itself, never the game loop.

using System.Threading.Channels;

public sealed class Client
{
    private readonly IReactiveConnection _connection;

    private readonly Channel<byte[]> _outbox = Channel.CreateBounded<byte[]>(new BoundedChannelOptions(2048)
    {
        SingleReader = true,
        FullMode = BoundedChannelFullMode.DropWrite
    });

    private static int _ids;

    public Client(IReactiveConnection connection)
    {
        _connection = connection;

        Id = Interlocked.Increment(ref _ids);
        Address = connection.Request.Client.Address?.ToString() ?? "unknown";

        _ = Pump();
    }

    public int Id { get; }

    /// <summary>The address the connection came from, used for bans.</summary>
    public string Address { get; }

    /// <summary>A random id the browser keeps in local storage, used for bans and to recognise the owner.</summary>
    public string Cid { get; set; } = "";

    public string Name { get; set; } = "Player";

    public int R = 15, G = 15, B = 4;

    /// <summary>The room this client is in, if any. Only changed by the room loop and the hub.</summary>
    public volatile Room Room;

    public bool Closed { get; private set; }

    /// <summary>The round trip time the browser measured, in seconds.</summary>
    public double Rtt { get; set; } = 0.1;

    /// <summary>When the last message came in, to drop connections that went silent.</summary>
    public DateTime LastSeen { get; set; } = DateTime.UtcNow;

    public void Send(byte[] frame)
    {
        if (Closed) return;

        if (!_outbox.Writer.TryWrite(frame))
        {
            // thousands of frames behind: this browser is not reading any more
            Close();
        }
    }

    public void Send(object message) => Send(Json.Encode(message));

    public void Close(string reason = null)
    {
        if (Closed) return;

        Closed = true;

        if (reason != null)
        {
            _outbox.Writer.TryWrite(Json.Encode(new Dictionary<string, object> { ["t"] = "bye", ["reason"] = reason }));
        }

        _outbox.Writer.TryComplete();
    }

    private async Task Pump()
    {
        try
        {
            await foreach (var frame in _outbox.Reader.ReadAllAsync())
            {
                await _connection.WriteAsync(frame, flush: _outbox.Reader.Count == 0);
            }

            await _connection.FlushAsync();

            if (Closed)
            {
                await _connection.CloseAsync();
            }
        }
        catch (Exception)
        {
            // the socket is gone; the hub's OnClose cleans up
            Closed = true;
        }
    }
}
