// The AI players. The characters (names and abilities) are the original's
// config/aiplayers.cfg; the thinking follows src/tron/gAIBase.cpp in spirit
// with fewer moving parts:
//
//   - a concentration model decides how quickly the AI can think again
//     (thinking fast drains it, so a dumb AI reacts late after a few turns)
//   - three sensors (ahead, left, right) see how much room there is, as far
//     ahead as the character's range allows
//   - smarter characters also flood the free area behind each choice, so they
//     do not turn into a pocket they cannot leave (the original's loop checks)
//   - near an enemy they evade what comes at them head on and cut off what
//     drives beside them (close combat)
//   - when its rubber touches a wall, the emergency reflex may kick in early

public sealed record AiCharacter(string Name, int Rs, int Er, int Vr, int Trace, int Close, int Path, int Loop, int Enemy, int Tunnel, int StartState, double StartStraight, double StateChange)
{
    public double Iq => (1 + 10.0 * (Rs + Er + Vr + Trace + Close + Path + Loop + Enemy + Tunnel)) * 10 / 101;

    public static readonly AiCharacter[] All =
    [
        new("Outlook", 3, 3, 0, 0, 0, 0, 0, 0, 4, 0, 10, 10),
        new("Notepad", 9, 5, 0, 0, 6, 6, 10, 0, 10, 0, 10, 10),
        new("Word", 4, 5, 3, 1, 5, 10, 0, 0, 0, 0, 10, 10),
        new("Excel", 6, 2, 3, 1, 5, 10, 0, 0, 0, 0, 10, 10),
        new("Emacs", 5, 2, 3, 10, 10, 0, 10, 10, 8, 0, 10, 10),
        new("Vi", 10, 6, 0, 10, 10, 0, 10, 10, 10, 0, 10, 10),
        new("Pine", 7, 5, 1, 10, 10, 0, 5, 10, 10, 0, 10, 10),
        new("Elm", 9, 7, 1, 10, 10, 0, 10, 10, 10, 0, 10, 10),
        new("LaTeX", 7, 5, 4, 10, 0, 0, 10, 0, 10, 0, 10, 10),
        new("TeX", 10, 7, 4, 10, 0, 0, 10, 0, 10, 0, 10, 10),
        new("Gcc", 8, 6, 6, 0, 0, 0, 10, 5, 7, 0, 10, 10),
        new("Gdb", 8, 10, 6, 0, 0, 0, 10, 5, 7, 0, 7, 10),
        new("MSVC++", 6, 6, 5, 5, 10, 10, 10, 5, 7, 0, 7, 10),
        new("Photoshop", 2, 4, 3, 0, 0, 10, 10, 10, 10, 0, 7, 10),
        new("Gimp", 3, 2, 3, 0, 0, 10, 10, 10, 10, 0, 7, 10),
        new("Windows", 7, 8, 8, 10, 10, 10, 10, 10, 10, 0, 5, 10),
        new("Linux", 7, 8, 8, 10, 10, 10, 10, 10, 10, 0, 5, 10),
        new("Unreal", 10, 10, 2, 10, 10, 10, 10, 10, 10, 1, 5, 10),
        new("Quake", 10, 10, 2, 10, 10, 10, 10, 10, 10, 1, 5, 10),
        new("Cycles3D", 10, 10, 10, 30, 1, 1, 10, 10, 10, 1, 7, 10),
        new("glTron", 10, 10, 10, 30, 1, 1, 10, 10, 10, 1, 7, 10),
        new("ArmagetronAd", 10, 10, 10, 30, 1, 1, 10, 10, 10, 1, 7, 10)
    ];

    // gAIBase.cpp: the thirteen colours AIs choose from
    public static readonly (double R, double G, double B)[] Colors =
    [
        (1, .2, .2), (.2, 1, .2), (.2, .2, 1), (1, 1, .2), (1, .2, 1), (.2, 1, 1), (1, .6, .2),
        (1, .2, .6), (.6, .2, 1), (.2, .6, 1), (1, 1, 1), (.2, .2, .2), (.5, .5, .5)
    ];
}

public sealed class Bot(AiCharacter character)
{
    private readonly Random _random = new();

    private double _nextThink, _concentration = 1, _lastTime, _nextStateChange;

    private bool _combat;

    public AiCharacter Character { get; } = character;

    public void Spawn(double start, double sizeMultiplier, SimSettings sim)
    {
        // STARTSTRAIGHT: drive straight for a while, like everybody does
        _nextThink = start + Character.StartStraight * sizeMultiplier * (20 / sim.Speed) * (0.7 + 0.6 * _random.NextDouble());
        _nextStateChange = start + Character.StateChange;
        _concentration = 1;
        _lastTime = start;
        _combat = Character.StartState == 2;
    }

    public void Think(Room room, World w, Cycle c, double now)
    {
        var ts = now - _lastTime;
        _lastTime = now;

        _concentration = Math.Max(_concentration, 0);
        _concentration += 4 * (Character.Rs + 1) * ts / 25;
        _concentration /= 1 + ts / 25;

        // the reflex: rubber is touching a wall and this one notices
        var emergency = c.RubberActive && _random.NextDouble() * 10 < Character.Er;

        if (!emergency && now < _nextThink) return;

        if (now >= _nextStateChange)
        {
            _nextStateChange = now + 5 + 10 * _random.NextDouble();
            _combat = Character.Close > 0 && _random.NextDouble() * 10 < Character.Close;
        }

        var next = Decide(room, w, c, now, emergency);

        if (next < 0.6 - _concentration) next = 0.6 - _concentration;

        _nextThink = now + next;

        if (0.1 + 4 * next < 1) _concentration *= 0.1 + 4 * next;
    }

    private sealed record Sense(double Distance, bool Rim, int Area);

    private double Decide(Room room, World w, Cycle c, double now, bool emergency)
    {
        var s = w.S;
        var speed = Math.Max(c.Speed(), 1);
        var delay = Math.Max(s.Delay * 0.9, 1.5 / Lobby.Rate);
        var range = speed;
        var look = Math.Min(range * (1 + Character.Vr * 0.6), w.Map.Size * 1.5);

        // left is +1, right is -1
        var options = new[] { 0, 1, -1 };
        var senses = new Sense[3];

        var smart = Character.Loop >= 5 && _random.NextDouble() * 10 < Character.Loop;

        Grid grid = smart ? room.BotGrid(w, now) : null;

        for (var i = 0; i < 3; i++)
        {
            var dir = (c.Dir + options[i] + 4) % 4;
            var (dx, dy) = Axes.Dirs[dir];

            var hit = w.Ray(c.X, c.Y, dx, dy, look, c, now);
            var distance = hit?.T ?? look;

            var area = int.MaxValue;

            if (grid != null)
            {
                var step = Math.Min(distance * 0.5, grid.Cell * 1.5);
                area = grid.Flood(c.X + dx * step, c.Y + dy * step, 2500);
            }

            senses[i] = new Sense(distance, hit is { Owner: null }, area);
        }

        var danger = new double[3];
        var maxArea = senses.Max(x => x.Area);

        for (var i = 0; i < 3; i++)
        {
            var d = senses[i].Distance;

            // SPACE: walls close ahead are dangerous, very close ones deadly
            danger[i] += 5 * range / (d + 0.2 * range);

            if (d < range) danger[i] += 20 * range / (d + 0.2 * range) + 1;
            if (senses[i].Rim) danger[i] += 10 * range / (d + 0.5 * range);
            if (d < speed * delay * 1.5 + 0.3) danger[i] += 1000;

            // LOOP: a pocket much smaller than the other choices is a trap
            if (grid != null && maxArea > 0 && senses[i].Area < maxArea)
            {
                var ratio = senses[i].Area / (double)maxArea;

                if (ratio < 0.6) danger[i] += 60 * (1 - ratio);
            }
        }

        // turning costs a little speed; do not do it for nothing
        danger[1] += 1;
        danger[2] += 1;

        double closest = double.MaxValue;

        foreach (var o in w.Cycles)
        {
            if (o == c || !o.Alive) continue;

            var rx = o.X - c.X;
            var ry = o.Y - c.Y;
            var dist = Math.Sqrt(rx * rx + ry * ry);

            closest = Math.Min(closest, dist);

            if (dist > 40 || Character.Enemy == 0) continue;

            // the enemy in our frame: y ahead, x to the left
            double fy = rx * c.Dx + ry * c.Dy, fx = -rx * c.Dy + ry * c.Dx;
            double ey = o.Dx * c.Dx + o.Dy * c.Dy, ex = -o.Dx * c.Dy + o.Dy * c.Dx;
            var es = Math.Max(o.Speed(), 1);
            var side = fx >= 0 ? 1 : -1;

            // COLLIDE: head on in our lane, or about to cross in front of us first
            if (ey < -0.5 && Math.Abs(fx) < 2 && fy > 0 && fy < 3 * speed)
            {
                danger[0] += 40;
            }
            else if (Math.Abs(ex) > 0.5 && fy > 0 && fy < 2 * speed && Math.Sign(ex) == -side)
            {
                var theirTime = Math.Abs(fx) / es;
                var ourTime = fy / speed;

                if (theirTime < ourTime * 1.2) danger[0] += 15 + 20 / (fy + 1);
            }

            // CLOSE COMBAT: beside or a little behind us, driving the same way:
            // turn into their lane before they get there
            if (_combat && ey > 0.5 && fy < 1 && fy > -15 && Math.Abs(fx) > 1 && Math.Abs(fx) < 12)
            {
                var ours = Math.Abs(fx) / speed;
                var theirs = (-fy + 1) / es;

                if (ours < theirs * 0.8)
                {
                    var toward = side > 0 ? 1 : 2;

                    if (senses[toward].Distance > Math.Abs(fx) + 3 && danger[toward] < 50)
                    {
                        danger[toward] -= 12;
                    }
                }
            }
        }

        // a little indecision in the less gifted
        var noise = (10 - Math.Min(Character.Rs, 10)) * 0.3;

        for (var i = 0; i < 3; i++)
        {
            danger[i] += noise * _random.NextDouble();
        }

        var best = 0;

        for (var i = 1; i < 3; i++)
        {
            if (danger[i] < danger[best]) best = i;
        }

        // straight stays unless a side is clearly better
        if (best != 0 && danger[0] <= danger[best] + (emergency ? 0 : 3) && danger[0] < 20)
        {
            best = 0;
        }

        if (best != 0)
        {
            w.RequestTurn(c, options[best]);
            room.BotTurned(c);
        }

        var front = senses[best == 0 ? 0 : best].Distance;
        var next = Math.Sqrt(Math.Min(8 * front * front, closest * closest)) / (3 * speed);

        next = Math.Min(next, 0.8 * senses[0].Distance / speed);

        return Math.Clamp(next, delay, 1);
    }
}

/// <summary>
/// A coarse picture of the arena for the AIs: which cells are walls, and how
/// big the free area around a point is.
/// </summary>
public sealed class Grid
{
    private readonly bool[] _blocked;

    private readonly int _n;

    private readonly int[] _queue;

    private readonly int[] _seen;

    private int _mark;

    public Grid(World w, double time)
    {
        Cell = Math.Max(1.0, w.Map.Size / 110);
        _n = (int)Math.Ceiling(w.Map.Size / Cell) + 1;
        _blocked = new bool[_n * _n];
        _queue = new int[_n * _n];
        _seen = new int[_n * _n];

        foreach (var c in w.Cycles)
        {
            var pts = c.Points;

            for (var i = 0; i < pts.Count; i++)
            {
                var p = pts[i];
                double qx, qy, qd;

                if (i + 1 < pts.Count)
                {
                    qx = pts[i + 1].X; qy = pts[i + 1].Y; qd = pts[i + 1].D;
                }
                else
                {
                    qx = c.X; qy = c.Y; qd = c.Dist;
                }

                var len = Math.Max(Math.Abs(qx - p.X), Math.Abs(qy - p.Y));
                var steps = (int)Math.Ceiling(len / (Cell * 0.5)) + 1;

                for (var k = 0; k <= steps; k++)
                {
                    var f = k / (double)steps;
                    var d = p.D + (qd - p.D) * f;

                    if (!w.WallDangerous(c, d, time)) continue;

                    Block(p.X + (qx - p.X) * f, p.Y + (qy - p.Y) * f);
                }
            }
        }
    }

    public double Cell { get; }

    private void Block(double x, double y)
    {
        int cx = (int)(x / Cell), cy = (int)(y / Cell);

        if (cx >= 0 && cy >= 0 && cx < _n && cy < _n) _blocked[cy * _n + cx] = true;
    }

    /// <summary>The number of free cells reachable from a point, up to a cap.</summary>
    public int Flood(double x, double y, int cap)
    {
        int cx = (int)(x / Cell), cy = (int)(y / Cell);

        if (cx < 0 || cy < 0 || cx >= _n - 1 || cy >= _n - 1) return 0;

        var start = cy * _n + cx;

        if (_blocked[start]) return 0;

        _mark++;

        int head = 0, tail = 0;

        _queue[tail++] = start;
        _seen[start] = _mark;

        while (head < tail && tail < cap)
        {
            var i = _queue[head++];
            int ix = i % _n, iy = i / _n;

            Visit(ix + 1, iy);
            Visit(ix - 1, iy);
            Visit(ix, iy + 1);
            Visit(ix, iy - 1);
        }

        return tail;

        void Visit(int vx, int vy)
        {
            // the last row and column are outside the rim
            if (vx < 0 || vy < 0 || vx >= _n - 1 || vy >= _n - 1) return;

            var j = vy * _n + vx;

            if (_blocked[j] || _seen[j] == _mark) return;

            _seen[j] = _mark;
            _queue[tail++] = j;
        }
    }
}

public sealed partial class Room
{
    private Grid _grid;

    private double _gridTime = -1;

    /// <summary>One picture of the arena per step, shared by all AIs.</summary>
    public Grid BotGrid(World w, double time)
    {
        if (_grid == null || _gridTime != time)
        {
            _grid = new Grid(w, time);
            _gridTime = time;
        }

        return _grid;
    }

    public void BotTurned(Cycle c)
    {
        // an immediate turn is announced now; a queued one when the queue makes it
        if (c.Points.Count > 0 && c.Points[^1].T == c.Time && c.Queue.Count == 0)
        {
            SendTurn(c);
        }
    }

    /// <summary>
    /// SetNumberOfAIs: fill up to the minimum number of players with the
    /// characters whose IQ is closest to the wanted one.
    /// </summary>
    private void UpdateBots()
    {
        var humans = Humans.Count(p => !p.WantsSpectator);
        var want = Math.Clamp(Settings.MinPlayers - humans, 0, 16 - humans);
        var bots = _players.Where(p => p.IsBot).ToList();

        double Fit(Player p) => Math.Abs(p.Bot.Character.Iq - Settings.AiIq);

        // swap AIs that no longer fit the wanted strength
        foreach (var bot in bots.OrderByDescending(Fit).ToList())
        {
            var better = FreeCharacter();

            if (better != null && Math.Abs(better.Iq - Settings.AiIq) + 8 < Fit(bot))
            {
                _players.Remove(bot);
                bots.Remove(bot);
                Broadcast($"{bot.Colored} 0xff7f7fleft the game.");
            }
        }

        while (bots.Count > want)
        {
            var worst = bots.OrderByDescending(Fit).First();
            bots.Remove(worst);
            _players.Remove(worst);
            Broadcast($"{worst.Colored} 0xff7f7fleft the game.");
        }

        while (bots.Count < want)
        {
            var character = FreeCharacter();

            if (character == null) break;

            var (r, g, b) = BotColor();

            var bot = new Player
            {
                Id = _nextPlayerId++,
                Bot = new Bot(character),
                Name = character.Name,
                R = r, G = g, B = b
            };

            _players.Add(bot);
            bots.Add(bot);

            Broadcast($"{bot.Colored} 0x7fff7fentered the game.");
        }

        _playersChanged = true;
    }

    private AiCharacter FreeCharacter()
    {
        var used = _players.Where(p => p.IsBot).Select(p => p.Bot.Character).ToHashSet();

        return AiCharacter.All.Where(c => !used.Contains(c)).OrderBy(c => Math.Abs(c.Iq - Settings.AiIq)).FirstOrDefault();
    }

    /// <summary>The colour least like everybody else's (and the floor's).</summary>
    private (int, int, int) BotColor()
    {
        var taken = _players.Select(p => (p.R / 15.0, p.G / 15.0, p.B / 15.0)).Append((.5, .5, .7)).ToList();

        var best = AiCharacter.Colors
            .Select((c, i) => (c, i, score: taken.Sum(t =>
            {
                var d = Math.Abs(t.Item1 - c.R) + Math.Abs(t.Item2 - c.G) + Math.Abs(t.Item3 - c.B);
                return Math.Exp(-4 * d * d);
            })))
            .OrderBy(x => x.score).ThenBy(x => x.i)
            .First().c;

        return ((int)(best.R * 15), (int)(best.G * 15), (int)(best.B * 15));
    }
}
