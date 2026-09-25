// One browser connected over the websocket. Everything the server sends goes
// through Send, which queues the frame: a single pump per client writes the
// queue to the socket, so there is never more than one write at a time and a
// slow browser only ever slows down itself, never the game loop.
//
// Nothing may write to the socket once the handler is done with it, so a
// closing connection first stops its pump (ShutdownAsync) and only then
// answers the close.

using System.Threading.Channels;

public sealed class Client
{
    private readonly IReactiveConnection _connection;

    private readonly Channel<(byte[] Data, FrameType Type)> _outbox = Channel.CreateBounded<(byte[], FrameType)>(new BoundedChannelOptions(2048)
    {
        SingleReader = true,
        FullMode = BoundedChannelFullMode.DropWrite
    });

    private readonly CancellationTokenSource _cancel = new();

    private readonly Task _pump;

    private volatile bool _closeSent;

    private static int _ids;

    public Client(IReactiveConnection connection)
    {
        _connection = connection;

        Id = Interlocked.Increment(ref _ids);
        Address = connection.Request.Client.Address?.ToString() ?? "unknown";

        _pump = Task.Run(Pump);
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

    public void Send(byte[] frame) => Enqueue(frame, FrameType.Text);

    public void Send(object message) => Send(Json.Encode(message));

    public void Pong(ReadOnlyMemory<byte> data) => Enqueue(data.ToArray(), FrameType.Pong);

    private void Enqueue(byte[] data, FrameType type)
    {
        if (Closed) return;

        if (!_outbox.Writer.TryWrite((data, type)))
        {
            // thousands of frames behind: this browser is not reading any more
            Close();
        }
    }

    /// <summary>
    /// Ends the connection from our side: whatever is queued (a last message
    /// saying why) goes out, then a close frame.
    /// </summary>
    public void Close(string reason = null)
    {
        if (Closed) return;

        if (reason != null)
        {
            _outbox.Writer.TryWrite((Json.Encode(new Dictionary<string, object> { ["t"] = "bye", ["reason"] = reason }), FrameType.Text));
        }

        Closed = true;

        _outbox.Writer.TryComplete();
    }

    /// <summary>
    /// The browser closed the connection (or it broke): stop writing, wait for
    /// the pump to finish, and answer the close if we did not close first.
    /// </summary>
    public async ValueTask ShutdownAsync()
    {
        Closed = true;

        _outbox.Writer.TryComplete();

        try
        {
            await _pump.WaitAsync(TimeSpan.FromSeconds(2));
        }
        catch (Exception)
        {
            // a write that hangs on a dead socket: give up on it
            await _cancel.CancelAsync();

            try
            {
                await _pump.WaitAsync(TimeSpan.FromSeconds(1));
            }
            catch (Exception)
            {
                // nothing more we can do
            }
        }

        if (!_closeSent)
        {
            _closeSent = true;

            try
            {
                await _connection.CloseAsync();
            }
            catch (Exception)
            {
                // gone already
            }
        }
    }

    private async Task Pump()
    {
        try
        {
            await foreach (var (data, type) in _outbox.Reader.ReadAllAsync(_cancel.Token))
            {
                await _connection.WriteAsync(data, type, flush: _outbox.Reader.Count == 0, token: _cancel.Token);
            }

            await _connection.FlushAsync(_cancel.Token);

            if (Closed && !_closeSent)
            {
                // we closed first (a kick, a full server)
                _closeSent = true;
                await _connection.CloseAsync(token: _cancel.Token);
            }
        }
        catch (Exception)
        {
            // the socket is gone; the hub's OnClose cleans up
            Closed = true;
        }
    }
}
